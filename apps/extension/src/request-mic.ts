import "./styles.css";

const grantButton = document.querySelector<HTMLButtonElement>("#grant-button");
const status = document.querySelector<HTMLElement>("#permission-status");

if (!grantButton || !status) {
  throw new Error("Microphone permission page is incomplete");
}

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  status.textContent = "Waiting for Chrome…";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    stream.getTracks().forEach((track) => track.stop());
    status.textContent = "Microphone access granted. You can close this tab.";
    grantButton.textContent = "Access granted";
    await chrome.runtime.sendMessage({
      target: "worker",
      type: "microphone-granted",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Permission was not granted";
    status.textContent = `${message}. Check Chrome and operating-system microphone settings, then try again.`;
    grantButton.disabled = false;
  }
});
