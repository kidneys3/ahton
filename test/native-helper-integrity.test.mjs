import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const helperUrl = new URL("../native/windows-focus-helper.exe", import.meta.url);
const checksumUrl = new URL("../native/windows-focus-helper.sha256", import.meta.url);
const sourceUrl = new URL("../native/windows-focus-helper.cpp", import.meta.url);

test("packaged native focus helper matches its reviewed build", () => {
  const expected = readFileSync(checksumUrl, "utf8").trim().toUpperCase();
  const actual = createHash("sha256").update(readFileSync(helperUrl)).digest("hex").toUpperCase();
  assert.match(expected, /^[A-F0-9]{64}$/);
  assert.equal(actual, expected);
});

test("native restore is limited to minimized windows", () => {
  const source = readFileSync(sourceUrl, "utf8");
  assert.match(source, /if \(IsIconic\(target\)\) \{\s*ShowWindowAsync\(target, SW_RESTORE\);\s*\}/);
  assert.equal((source.match(/ShowWindowAsync\(target, SW_RESTORE\)/g) ?? []).length, 1);
});

test("native popup is fixed-content, non-activating, and authority-bound", () => {
  const source = readFileSync(sourceUrl, "utf8");
  assert.match(source, /WS_EX_TOPMOST \| WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE/);
  assert.match(source, /isVsCodeWindow\(target, extensionHostPid\)/);
  assert.match(source, /Click anywhere to open  \|  Right-click to dismiss/);
  assert.match(source, /case WM_LBUTTONDOWN:[\s\S]*SetCapture\(window\)[\s\S]*case WM_LBUTTONUP:[\s\S]*const bool wasPressed = notificationPressed[\s\S]*if \(wasPressed && PtInRect\(&client, point\)\)/);
  assert.match(source, /GetTickCount64\(\) - notificationShownAt >= kNotificationArmDelayMs/);
  assert.match(source, /kNotificationLifetimeMs = 120000/);
  assert.match(source, /kAzureAnimationPeriodMs = 12000/);
  assert.match(source, /kAnimationFrameMs = 50/);
  assert.match(source, /SPI_GETCLIENTAREAANIMATION/);
  assert.match(source, /WM_ERASEBKGND:[\s\S]*BitBlt/);
  assert.match(source, /L"Terminal " \+ std::to_wstring\(displayIndex\)/);
  assert.doesNotMatch(source, /conversation/i);
  assert.match(source, /argc == 8[\s\S]*parseNonNegative\(argv\[7\], displayIndexValue\)/);
  assert.match(source, /\*cursor < L'0' \|\| \*cursor > L'9'/);
  assert.equal(source.includes("SnoreToast"), false);
});

test("native click guard measures from when the popup is shown, not from zero", () => {
  const source = readFileSync(sourceUrl, "utf8");
  assert.doesNotMatch(source, /^\s+notificationShownAt = 0;/m);
  assert.match(source, /ShowWindow\(window, SW_SHOWNOACTIVATE\);[\s\S]*notificationShownAt = GetTickCount64\(\);[\s\S]*GetMessageW/);
});
