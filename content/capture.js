"use strict";

(() => {
  if (globalThis.__scrollCaptureLoaded) {
    return;
  }

  globalThis.__scrollCaptureLoaded = true;

  const SESSION_WAIT_MS = 120;
  const TOAST_TIMEOUT_MS = 2400;
  const TEXT_TAGS = new Set([
    "a",
    "blockquote",
    "caption",
    "dd",
    "div",
    "dt",
    "figcaption",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "label",
    "legend",
    "li",
    "p",
    "pre",
    "section",
    "small",
    "span",
    "strong",
  ]);
  const INTRINSIC_TAGS = new Set([
    "button",
    "canvas",
    "embed",
    "fieldset",
    "iframe",
    "img",
    "input",
    "meter",
    "object",
    "option",
    "progress",
    "select",
    "svg",
    "textarea",
    "video",
  ]);

  const sessions = new Map();
  let toastTimer = null;
  let toastHost = null;
  let toastMessage = null;

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "ping") {
      return Promise.resolve({ ok: true });
    }

    if (message?.type === "prepareCapture") {
      return prepareCapture(message.mode);
    }

    if (message?.type === "moveCaptureViewport") {
      return moveCaptureViewport(message.sessionId, message.x, message.y);
    }

    if (message?.type === "finalizeCapture") {
      return finalizeCapture(message.sessionId);
    }

    if (message?.type === "captureStatus") {
      showToast(message.message, message.level === "error");
      return Promise.resolve({ ok: true });
    }

    return undefined;
  });

  async function prepareCapture(mode) {
    if (mode !== "expanded") {
      throw new Error(`Unsupported capture mode in content script: ${mode}`);
    }

    const session = {
      id: crypto.randomUUID(),
      styleByElement: new Map(),
      scrollByElement: new Map(),
      originalWindowScroll: {
        x: window.scrollX,
        y: window.scrollY,
      },
      styleTag: null,
    };

    sessions.set(session.id, session);

    try {
      installCaptureStyles(session);
      expandDocumentForCapture(session);
      await waitForSettled();

      const viewport = {
        width: Math.max(1, Math.floor(window.innerWidth)),
        height: Math.max(1, Math.floor(window.innerHeight)),
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      const documentSize = measureDocument();
      const tiles = buildTilePlan(documentSize, viewport);

      return {
        ok: true,
        sessionId: session.id,
        title: document.title.trim() || "Capture",
        url: location.href,
        viewport,
        documentSize,
        tiles,
      };
    } catch (error) {
      await finalizeCapture(session.id);
      throw error;
    }
  }

  async function moveCaptureViewport(sessionId, x, y) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error("Capture session was not found.");
    }

    window.scrollTo(x, y);
    await waitForSettled();

    return {
      ok: true,
      x: window.scrollX,
      y: window.scrollY,
    };
  }

  async function finalizeCapture(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: true, restored: false };
    }

    sessions.delete(sessionId);

    if (session.styleTag?.isConnected) {
      session.styleTag.remove();
    }

    document.documentElement.removeAttribute("data-scroll-capture-active");

    for (const [element, originalStyle] of session.styleByElement) {
      if (!element.isConnected) {
        continue;
      }

      if (originalStyle === null) {
        element.removeAttribute("style");
      } else {
        element.setAttribute("style", originalStyle);
      }
    }

    for (const [element, scrollState] of session.scrollByElement) {
      if (!element.isConnected) {
        continue;
      }

      element.scrollLeft = scrollState.left;
      element.scrollTop = scrollState.top;
    }

    window.scrollTo(session.originalWindowScroll.x, session.originalWindowScroll.y);
    await waitForSettled(60);

    return { ok: true, restored: true };
  }

  function installCaptureStyles(session) {
    const styleTag = document.createElement("style");
    styleTag.setAttribute("data-scroll-capture-ignore", "true");
    styleTag.textContent = `
      html[data-scroll-capture-active="true"],
      body[data-scroll-capture-active="true"] {
        scroll-behavior: auto !important;
      }

      html[data-scroll-capture-active="true"] *,
      html[data-scroll-capture-active="true"] *::before,
      html[data-scroll-capture-active="true"] *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `;
    document.head.appendChild(styleTag);
    document.documentElement.setAttribute("data-scroll-capture-active", "true");
    session.styleTag = styleTag;
  }

  function expandDocumentForCapture(session) {
    for (const root of uniqueElements([document.documentElement, document.body, document.scrollingElement])) {
      if (!(root instanceof HTMLElement)) {
        continue;
      }

      rememberStyle(session, root);
      root.style.setProperty("overflow", "visible", "important");
      root.style.setProperty("overflow-x", "visible", "important");
      root.style.setProperty("overflow-y", "visible", "important");
      root.style.setProperty("height", "auto", "important");
      root.style.setProperty("min-height", "0", "important");
      root.style.setProperty("max-height", "none", "important");
      root.style.setProperty("max-width", "none", "important");
    }

    flattenFixedAndStickyElements(session);
    expandScrollableElements(session);
    relaxTextElementHeights(session);

    window.scrollTo(0, 0);
  }

  function flattenFixedAndStickyElements(session) {
    for (const element of document.body.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement) || shouldIgnoreElement(element)) {
        continue;
      }

      const computed = getComputedStyle(element);
      if (computed.position !== "fixed" && computed.position !== "sticky") {
        continue;
      }

      rememberStyle(session, element);
      element.style.setProperty("position", "static", "important");
      element.style.setProperty("top", "auto", "important");
      element.style.setProperty("right", "auto", "important");
      element.style.setProperty("bottom", "auto", "important");
      element.style.setProperty("left", "auto", "important");
      element.style.setProperty("transform", "none", "important");
      element.style.setProperty("inset", "auto", "important");
    }
  }

  function expandScrollableElements(session) {
    for (const element of document.body.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement) || shouldIgnoreElement(element)) {
        continue;
      }

      const computed = getComputedStyle(element);
      if (computed.position === "fixed") {
        continue;
      }

      const canExpandY = element.scrollHeight > element.clientHeight + 1 && computed.overflowY !== "visible";
      const canExpandX = element.scrollWidth > element.clientWidth + 1 && computed.overflowX !== "visible";
      if (!canExpandX && !canExpandY) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        continue;
      }

      rememberStyle(session, element);
      rememberScroll(session, element);
      element.scrollLeft = 0;
      element.scrollTop = 0;
      element.style.setProperty("overflow", "visible", "important");
      element.style.setProperty("overflow-x", "visible", "important");
      element.style.setProperty("overflow-y", "visible", "important");
      element.style.setProperty("max-height", "none", "important");
      element.style.setProperty("max-width", "none", "important");
      element.style.setProperty("contain", "none", "important");

      if (canExpandY) {
        element.style.setProperty("height", `${Math.ceil(element.scrollHeight)}px`, "important");
        element.style.setProperty("min-height", "0", "important");
      }

      if (canExpandX) {
        element.style.setProperty("width", `${Math.ceil(element.scrollWidth)}px`, "important");
        element.style.setProperty("min-width", "0", "important");
      }
    }
  }

  function relaxTextElementHeights(session) {
    for (const element of document.body.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement) || shouldIgnoreElement(element)) {
        continue;
      }

      if (!isTextHeightCandidate(element)) {
        continue;
      }

      rememberStyle(session, element);
      element.style.setProperty("height", "auto", "important");
      element.style.setProperty("min-height", "0", "important");
      element.style.setProperty("max-height", "none", "important");
    }
  }

  function isTextHeightCandidate(element) {
    const tagName = element.tagName.toLowerCase();
    if (!TEXT_TAGS.has(tagName) || INTRINSIC_TAGS.has(tagName)) {
      return false;
    }

    if (element.querySelector("button, canvas, embed, iframe, img, input, object, select, svg, textarea, video")) {
      return false;
    }

    const computed = getComputedStyle(element);
    if (!["block", "inline-block", "list-item"].includes(computed.display)) {
      return false;
    }

    if (computed.position === "absolute" || computed.position === "fixed") {
      return false;
    }

    if (
      /(hidden|clip|scroll|auto|overlay)/.test(computed.overflow) ||
      /(hidden|clip|scroll|auto|overlay)/.test(computed.overflowY)
    ) {
      return false;
    }

    const text = (element.textContent || "").trim();
    if (text.length < 2) {
      return false;
    }

    return element.children.length <= 8;
  }

  function measureDocument() {
    const body = document.body;
    const root = document.documentElement;

    return {
      width: Math.max(
        root.clientWidth,
        root.scrollWidth,
        body ? body.clientWidth : 0,
        body ? body.scrollWidth : 0
      ),
      height: Math.max(
        root.clientHeight,
        root.scrollHeight,
        body ? body.clientHeight : 0,
        body ? body.scrollHeight : 0
      ),
    };
  }

  function buildTilePlan(documentSize, viewport) {
    const xs = buildAxisPositions(documentSize.width, viewport.width);
    const ys = buildAxisPositions(documentSize.height, viewport.height);
    const tiles = [];

    for (let row = 0; row < ys.length; row += 1) {
      for (let col = 0; col < xs.length; col += 1) {
        tiles.push({
          index: tiles.length,
          row,
          col,
          x: xs[col],
          y: ys[row],
        });
      }
    }

    return tiles;
  }

  function buildAxisPositions(fullSize, viewportSize) {
    const positions = [];
    const step = Math.max(1, viewportSize);
    const maxStart = Math.max(0, fullSize - viewportSize);

    for (let current = 0; current < maxStart; current += step) {
      positions.push(current);
    }

    positions.push(maxStart);
    return Array.from(new Set(positions));
  }

  function rememberStyle(session, element) {
    if (!session.styleByElement.has(element)) {
      session.styleByElement.set(element, element.getAttribute("style"));
    }
  }

  function rememberScroll(session, element) {
    if (!session.scrollByElement.has(element)) {
      session.scrollByElement.set(element, {
        left: element.scrollLeft,
        top: element.scrollTop,
      });
    }
  }

  function shouldIgnoreElement(element) {
    return element.hasAttribute("data-scroll-capture-ignore") || element.closest("[data-scroll-capture-ignore]");
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter(Boolean)));
  }

  async function waitForSettled(extraDelay = SESSION_WAIT_MS) {
    if (document.fonts?.status !== "loaded") {
      try {
        await Promise.race([document.fonts.ready, delay(500)]);
      } catch (error) {
        // Ignore font readiness failures and continue with layout stabilization.
      }
    }

    await nextFrame();
    await delay(extraDelay);
    await nextFrame();
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function showToast(message, isError = false) {
    if (!toastHost) {
      toastHost = document.createElement("scroll-capture-toast");
      toastHost.setAttribute("data-scroll-capture-ignore", "true");
      toastHost.style.cssText =
        "all: initial !important; position: fixed !important; right: 20px !important;" +
        "bottom: 20px !important; z-index: 2147483647 !important; pointer-events: none !important;";

      const shadow = toastHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        .toast {
          min-width: 220px;
          max-width: 360px;
          padding: 12px 14px;
          border-radius: 14px;
          background: rgba(15, 23, 42, 0.92);
          color: #f8fafc;
          font: 600 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 20px 40px rgba(15, 23, 42, 0.28);
        }

        .toast.error {
          background: rgba(127, 29, 29, 0.95);
        }
      `;

      toastMessage = document.createElement("div");
      toastMessage.className = "toast";
      toastMessage.hidden = true;
      shadow.append(style, toastMessage);
      document.documentElement.appendChild(toastHost);
    }

    if (!(toastMessage instanceof HTMLElement)) {
      return;
    }

    toastMessage.hidden = false;
    toastMessage.textContent = message;
    toastMessage.classList.toggle("error", Boolean(isError));

    if (toastTimer) {
      clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
      if (!(toastMessage instanceof HTMLElement)) {
        return;
      }

      toastMessage.hidden = true;
      toastMessage.textContent = "";
    }, TOAST_TIMEOUT_MS);
  }
})();
