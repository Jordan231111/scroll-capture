const status = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("[data-mode]"));

for (const button of buttons) {
  button.addEventListener("click", async () => {
    const mode = button.getAttribute("data-mode");
    if (!mode) {
      return;
    }

    try {
      setBusy(true);
      setStatus(statusLabelForMode(mode), false);
      const result = await browser.runtime.sendMessage({
        type: "runCapture",
        mode,
      });
      setStatus(result?.filename ? `Saved ${result.filename}` : "Capture completed.", false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  });
}

async function hydrateState() {
  try {
    const state = await browser.runtime.sendMessage({ type: "getCaptureState" });
    if (state?.busy) {
      setBusy(true);
      setStatus(`Another capture is running (${state.mode}).`, false);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function setBusy(isBusy) {
  for (const button of buttons) {
    button.disabled = isBusy;
  }
}

function setStatus(message, isError) {
  status.textContent = message;
  status.classList.toggle("error", Boolean(isError));
}

function statusLabelForMode(mode) {
  switch (mode) {
    case "visible-png":
      return "Capturing current viewport…";
    case "visible-pdf":
      return "Building single-page PDF…";
    case "expanded-pdf":
      return "Preparing expanded capture…";
    default:
      return "Running capture…";
  }
}

hydrateState();
