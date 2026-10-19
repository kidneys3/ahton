# Windows focus helper

`windows-focus-helper.exe` is a small Win32 helper that shows Ahton's own
fixed-content popup and, after an explicit click, focuses an exact VS Code
window. It captures the owning window while that window is known to be
foreground, then verifies the same HWND and extension-host ancestry at use.

Every capture and focus operation binds the HWND to the current extension-host
process by checking the native window class and the Windows process ancestry.
The popup is topmost but does not activate itself or take keyboard focus.
After a brief click-through guard, clicking anywhere on it returns an
affirmative result; right-click and its fixed two-minute timeout fail closed.
Its white surface has a single Azure prism that crosses the top edge over
12 seconds; Windows' reduced-animation setting disables that movement. A
generated session-local label such as `Terminal 3` identifies the target
without exposing the terminal's real title. The helper accepts only
process/window integers, fixed provider/reason/display enums, that ordinal, an
optional validated label and an optional validated VS Code folder name (at most
28 characters, four words, letters, digits, spaces and `& . _ -`). The folder
name leads the chip, for example `api · Terminal 3`; with none, the chip is
unchanged. The helper ignores a name outside those rules and never receives
paths, prompts, replies, raw terminal names, or chat identifiers. Only terminal
display targets are valid.

Build an x64 release binary from a Visual Studio developer prompt:

```powershell
cl.exe /nologo /std:c++17 /O2 /EHsc /DUNICODE /D_UNICODE `
  native\windows-focus-helper.cpp /Fe:native\windows-focus-helper.exe `
  /Fo:native\windows-focus-helper.obj /link user32.lib gdi32.lib shcore.lib
```

The checked binary is packaged in the Windows-only extension so a
machine installing the VSIX does not need Visual Studio Build Tools. The 0.6.6
binary was rebuilt on 2026-08-26 with MSVC for x64; its reviewed hash
is enforced by `test/native-helper-integrity.test.mjs`.
