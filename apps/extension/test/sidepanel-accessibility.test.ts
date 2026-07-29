import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelMarkup = readFileSync(
  new URL("../sidepanel.html", import.meta.url),
  "utf8",
);
const panelStyles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
const panelSource = readFileSync(
  new URL("../src/sidepanel.ts", import.meta.url),
  "utf8",
);

function openingTag(id: string): string {
  const tag = panelMarkup.match(
    new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, "s"),
  )?.[0];
  if (!tag) throw new Error(`Missing panel element: ${id}`);
  return tag;
}

describe("side-panel accessibility structure", () => {
  it("provides live regions and control semantics", () => {
    expect(openingTag("status-chip")).toContain('role="status"');
    expect(openingTag("transcript")).toContain('aria-live="polite"');
    expect(openingTag("pipeline-error")).toContain('role="alert"');
    expect(openingTag("action-log-announcer")).toContain(
      'aria-live="polite"',
    );
    expect(openingTag("latency-summary")).toContain('aria-live="polite"');

    expect(openingTag("listen-button")).toContain('aria-pressed="false"');
    expect(openingTag("listen-button")).toContain(
      'aria-labelledby="listen-label"',
    );
    expect(openingTag("quiet-mode")).toContain('role="switch"');
    expect(openingTag("quiet-mode")).toContain(
      'aria-labelledby="quiet-mode-label"',
    );
    expect(openingTag("mic-meter")).toContain('role="meter"');
    expect(openingTag("mic-meter")).toContain('aria-valuemin="0"');
    expect(openingTag("mic-meter")).toContain('aria-valuemax="100"');
    expect(openingTag("mic-meter")).toContain('aria-valuenow="0"');
    expect(openingTag("mic-meter")).toContain(
      'aria-label="Microphone input level"',
    );
    expect(openingTag("pause-reading")).toContain('type="button"');
    expect(openingTag("skip-reading")).toContain('type="button"');
    expect(openingTag("reading-text-output")).toContain('role="region"');
    expect(openingTag("reading-text-output")).toContain('tabindex="0"');
  });

  it("renders reading sentences through textContent only", () => {
    expect(panelSource).toContain(
      "sentenceElement.textContent = sentence.text;",
    );
    expect(panelSource).not.toContain("innerHTML");
    expect(panelSource).not.toContain("insertAdjacentHTML");
  });

  it("uses labels and ordered headings", () => {
    expect(openingTag("setup-list")).toMatch(/^<ol\b/);
    expect(openingTag("setup-microphone-state")).toContain(
      'role="status"',
    );
    expect(openingTag("setup-capture-state")).toContain(
      'aria-live="polite"',
    );
    expect(openingTag("setup-nano-state")).toContain(
      'aria-live="polite"',
    );
    expect(openingTag("setup-premium-state")).toContain(
      'aria-live="polite"',
    );
    expect(openingTag("dismiss-setup")).toContain('type="button"');
    expect(panelMarkup).toContain("Setup complete");
    expect(panelMarkup).not.toContain('class="onboarding"');
    expect(panelMarkup).toMatch(
      /<label for="command-input">TYPE A COMMAND<\/label>/,
    );
    expect(panelMarkup).toMatch(
      /<label class="voice-switch" for="premium-voice-enabled">/,
    );
    expect(panelMarkup).toMatch(
      /<label class="voice-switch" for="premium-stt-enabled">/,
    );
    expect(panelMarkup).toMatch(
      /class="quiet-switch"[\s\S]*for="quiet-mode"/,
    );
    expect(panelMarkup).toContain('<label for="speech-rate">Rate</label>');
    expect(panelMarkup).toContain(
      '<label for="speech-volume">Volume</label>',
    );
    expect(panelMarkup).toContain(
      '<label for="response-verbosity">Response length</label>',
    );
    expect(openingTag("speech-rate")).toContain('type="range"');
    expect(openingTag("speech-rate")).toContain('min="0.5"');
    expect(openingTag("speech-rate")).toContain('max="2"');
    expect(openingTag("speech-volume")).toContain('type="range"');
    expect(openingTag("speech-volume")).toContain('min="0"');
    expect(openingTag("speech-volume")).toContain('max="1"');
    expect(openingTag("response-verbosity")).toMatch(/^<select\b/);
    expect(panelMarkup).toContain('<option value="normal">Normal</option>');
    expect(panelMarkup).toContain('<option value="brief">Brief</option>');

    const headingLevels = Array.from(
      panelMarkup.matchAll(/<h([1-6])(?:\s|>)/g),
      (match) => Number(match[1]),
    );
    expect(headingLevels[0]).toBe(1);
    for (let index = 1; index < headingLevels.length; index += 1) {
      expect(headingLevels[index]).toBeLessThanOrEqual(
        headingLevels[index - 1]! + 1,
      );
    }
  });
});

describe("side-panel preference styles", () => {
  it("defines core theme properties for dark and light schemes", () => {
    const lightStart = panelStyles.indexOf(
      "@media (prefers-color-scheme: light)",
    );
    const darkTheme = panelStyles.slice(0, lightStart);
    const lightTheme = panelStyles.slice(
      lightStart,
      panelStyles.indexOf("\n* {", lightStart),
    );

    for (const property of [
      "--ink",
      "--paper",
      "--paper-dim",
      "--rule",
      "--acid",
      "--acid-ink",
      "--danger",
    ]) {
      expect(darkTheme).toContain(`${property}:`);
      expect(lightTheme).toContain(`${property}:`);
    }
    expect(lightTheme).toContain("color-scheme: light");
  });

  it("removes animation and transitions for reduced motion", () => {
    const reducedMotion = panelStyles.slice(
      panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(reducedMotion).toContain("animation: none !important");
    expect(reducedMotion).toContain("transition: none !important");
  });

  it("dims recovery hints on a separate line", () => {
    const recoveryStyles = panelStyles.slice(
      panelStyles.indexOf(".recovery-hint {"),
      panelStyles.indexOf(".control-panel {"),
    );
    expect(recoveryStyles).toContain("display: block");
    expect(recoveryStyles).toContain("color: var(--paper-dim)");
  });
});
