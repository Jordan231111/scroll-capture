import { PDFDocument } from "../vendor/pdf-lib.esm.min.js";

const BLOCKED_PROTOCOLS = ["about:", "chrome:", "edge:", "moz-extension:", "view-source:"];
const CAPTURE_FORMAT = "png";
const CAPTURE_QUALITY = 100;
const SCROLL_SETTLE_MS = 120;
const SAVE_DIRECTLY_TO_DOWNLOADS = true;

let activeJob = null;
const downloadUrls = new Map();

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "runCapture") {
    return runCapture(message.mode);
  }

  if (message?.type === "getCaptureState") {
    return Promise.resolve({
      busy: Boolean(activeJob),
      mode: activeJob?.mode || null,
    });
  }

  return undefined;
});

browser.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !downloadUrls.has(delta.id)) {
    return;
  }

  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") {
    return;
  }

  URL.revokeObjectURL(downloadUrls.get(delta.id));
  downloadUrls.delete(delta.id);
});

async function runCapture(mode) {
  if (activeJob) {
    throw new Error(`Another capture is already running (${activeJob.mode}).`);
  }

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active tab is available.");
  }

  if (BLOCKED_PROTOCOLS.some((prefix) => tab.url?.startsWith(prefix))) {
    throw new Error("This page cannot be captured by extensions.");
  }

  activeJob = {
    tabId: tab.id,
    windowId: tab.windowId,
    mode,
    startedAt: Date.now(),
  };

  try {
    await ensureCaptureScript(tab.id);

    switch (mode) {
      case "visible-png":
        return await runVisiblePngCapture(tab);
      case "visible-pdf":
        return await runVisiblePdfCapture(tab);
      case "expanded-pdf":
        return await runExpandedPdfCapture(tab);
      default:
        throw new Error(`Unknown capture mode: ${mode}`);
    }
  } finally {
    activeJob = null;
  }
}

async function runVisiblePngCapture(tab) {
  await sendStatus(tab.id, "Capturing visible viewport…");
  const dataUrl = await captureVisibleTab(tab.windowId);
  const filename = buildDownloadName(tab.title, "visible", "png");
  await downloadDataUrlAsBlob(dataUrl, filename, shouldPromptForSave());
  await sendStatus(tab.id, `Saved ${filename}`);
  return { ok: true, filename };
}

async function runVisiblePdfCapture(tab) {
  await sendStatus(tab.id, "Capturing visible viewport…");
  const dataUrl = await captureVisibleTab(tab.windowId);
  const pdfBytes = await buildPdfFromTiles(
    {
      title: tab.title || "Capture",
      mode: "visible-pdf",
    },
    [
      {
        dataUrl,
        viewportWidth: 0,
        viewportHeight: 0,
      },
    ]
  );
  const filename = buildDownloadName(tab.title, "visible", "pdf");
  await downloadBytes(pdfBytes, filename, "application/pdf", shouldPromptForSave());
  await sendStatus(tab.id, `Saved ${filename}`);
  return { ok: true, filename };
}

async function runExpandedPdfCapture(tab) {
  const prepared = await browser.tabs.sendMessage(tab.id, {
    type: "prepareCapture",
    mode: "expanded",
  });

  if (!prepared?.ok) {
    throw new Error("The page did not return a valid capture plan.");
  }

  const tiles = [];

  try {
    const total = prepared.tiles.length;
    await sendStatus(tab.id, `Capturing ${total} tile${total === 1 ? "" : "s"}…`);

    for (let index = 0; index < total; index += 1) {
      const tile = prepared.tiles[index];
      await browser.tabs.sendMessage(tab.id, {
        type: "moveCaptureViewport",
        sessionId: prepared.sessionId,
        x: tile.x,
        y: tile.y,
      });
      await delay(SCROLL_SETTLE_MS);

      const dataUrl = await captureVisibleTab(tab.windowId);
      tiles.push({
        ...tile,
        dataUrl,
        viewportWidth: prepared.viewport.width,
        viewportHeight: prepared.viewport.height,
      });

      if (total > 1) {
        await sendStatus(tab.id, `Captured tile ${index + 1} of ${total}`);
      }
    }
  } finally {
    await browser.tabs.sendMessage(tab.id, {
      type: "finalizeCapture",
      sessionId: prepared.sessionId,
    }).catch(() => undefined);
  }

  const pdfBytes = await buildPdfFromTiles(prepared, tiles);
  const filename = buildDownloadName(prepared.title, "expanded", "pdf");
  await downloadBytes(pdfBytes, filename, "application/pdf", shouldPromptForSave());
  await sendStatus(tab.id, `Saved ${filename}`);
  return { ok: true, filename };
}

async function buildPdfFromTiles(metadata, tiles) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(metadata.title || "Scroll Capture");
  pdfDoc.setProducer("Scroll Capture");
  pdfDoc.setCreator("Scroll Capture");

  for (const tile of tiles) {
    const embedded = await pdfDoc.embedPng(tile.dataUrl);
    const pageWidth = tile.viewportWidth || embedded.width;
    const pageHeight = tile.viewportHeight || embedded.height;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });
  }

  return pdfDoc.save();
}

async function captureVisibleTab(windowId) {
  return browser.tabs.captureVisibleTab(windowId, {
    format: CAPTURE_FORMAT,
    quality: CAPTURE_QUALITY,
  });
}

async function ensureCaptureScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "ping" });
    return;
  } catch (error) {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["content/capture.js"],
    });
  }
}

async function sendStatus(tabId, message, level = "info") {
  if (!tabId) {
    return;
  }

  try {
    await browser.tabs.sendMessage(tabId, {
      type: "captureStatus",
      message,
      level,
    });
  } catch (error) {
    // Ignore pages that no longer have the content script.
  }
}

async function downloadDataUrlAsBlob(dataUrl, filename, saveAs) {
  const { bytes, mimeType } = decodeDataUrl(dataUrl);
  return downloadBytes(bytes, filename, mimeType, saveAs);
}

async function downloadBytes(bytes, filename, mimeType, saveAs) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await browser.downloads.download({
      url,
      filename,
      saveAs,
      conflictAction: "uniquify",
    });
    downloadUrls.set(downloadId, url);
    return downloadId;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function buildDownloadName(title, modeLabel, extension) {
  const safeTitle = sanitizeFilename(title || "capture");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeTitle} - ${modeLabel} - ${timestamp}.${extension}`;
}

function sanitizeFilename(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "capture";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPromptForSave() {
  return !SAVE_DIRECTLY_TO_DOWNLOADS;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Capture data could not be decoded.");
  }

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const body = match[3] || "";

  if (!isBase64) {
    return {
      mimeType,
      bytes: new TextEncoder().encode(decodeURIComponent(body)),
    };
  }

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { mimeType, bytes };
}
