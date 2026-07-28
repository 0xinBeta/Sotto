import "./styles.css";

const grantButton = document.querySelector<HTMLButtonElement>("#grant-button");
const status = document.querySelector<HTMLElement>("#permission-status");

if (!grantButton || !status) {
  throw new Error("Microphone permission page is incomplete");
}

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  status.textContent = "Waiting for Chrome…";

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Permission was not granted";
    status.textContent = `${message}. Check Chrome and operating-system microphone settings, or close this tab and use Sotto’s text-command box.`;
    grantButton.disabled = false;
    return;
  }

  stream.getTracks().forEach((track) => track.stop());
  status.textContent = "Microphone access granted. You can close this tab.";
  grantButton.textContent = "Access granted";

  try {
    const response = (await chrome.runtime.sendMessage({
      target: "worker",
      type: "microphone-granted",
    })) as { readonly ok?: boolean } | undefined;
    if (response?.ok === false) {
      throw new Error("Sotto could not refresh its microphone status");
    }
  } catch (error) {
    console.warn("Microphone was granted but Sotto status refresh failed", error);
    status.textContent =
      "Microphone access is granted. Close this tab and reopen Sotto if its status does not refresh.";
  }
});
