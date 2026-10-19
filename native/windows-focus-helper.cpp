#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellscalingapi.h>
#include <tlhelp32.h>

#include <cwchar>
#include <cerrno>
#include <cmath>
#include <iostream>
#include <iterator>
#include <string>
#include <unordered_map>

namespace {

constexpr int kInvalidArguments = 10;
constexpr int kInvalidWindow = 11;
constexpr int kUnauthorizedWindow = 12;
constexpr int kFocusFailed = 13;
constexpr int kCaptureUnavailable = 14;
constexpr int kNotificationDismissed = 20;
constexpr int kNotificationTimedOut = 21;
constexpr int kNotificationFailed = 22;
constexpr UINT_PTR kNotificationTimer = 1;
constexpr UINT_PTR kAnimationTimer = 2;
constexpr UINT kNotificationLifetimeMs = 120000;
constexpr UINT kAnimationFrameMs = 50;
constexpr ULONGLONG kAzureAnimationPeriodMs = 12000;
constexpr ULONGLONG kNotificationArmDelayMs = 600;

// The popup's layout was authored at 96 DPI and the process was DPI-unaware, so
// Windows stretched the bitmap on a 200% display: physically the right size,
// visibly blurred. The process now declares per-monitor awareness and scales its
// own geometry, so the popup is drawn at the monitor's real pixel density.
// kBaseWidth and kBaseHeight stay in the original design units.
constexpr int kBaseWidth = 390;
constexpr int kBaseHeight = 128;
constexpr int kBaseMargin = 18;
constexpr int kBaseSlotGap = 10;
// A second popup must not land on top of the first. Slots stack upward from the
// corner. Four is the number that fits above the tray on a 900-unit work area
// with the margin and gap below; beyond that the oldest position is reused.
constexpr int kSlotCount = 4;
// The floor is below 1.0 so the card can be made smaller than the original
// design as well as larger. Below about 0.6 the tab label stops being readable.
constexpr double kMinSizeFactor = 0.6;
constexpr double kMaxSizeFactor = 2.0;
constexpr double kDefaultSizeFactor = 0.92;

// Two factors, deliberately separate. notificationScale is dpi/96 * sizeFactor and
// applies to geometry drawn in raw device pixels. notificationSizeFactor is the
// size factor alone and applies to font point sizes, because CreateFontW already
// converts points using the monitor DPI -- multiplying by the full scale there
// would apply DPI twice.
double notificationScale = 1.0;
double notificationSizeFactor = 1.0;

// Round to whole device pixels. Every hard-coded design coordinate passes
// through this, so one factor changes the whole popup coherently.
int sc(int value) {
    return static_cast<int>(value * notificationScale + (value < 0 ? -0.5 : 0.5));
}

int notificationOutcome = kNotificationFailed;
bool notificationPressed = false;
ULONGLONG notificationShownAt = 0;
ULONGLONG notificationAnimationStartedAt = 0;
std::wstring notificationTitle;
std::wstring notificationTabLabel;
bool notificationIsCodex = false;
HDC notificationBuffer = nullptr;
HBITMAP notificationBitmap = nullptr;
HGDIOBJ notificationOldBitmap = nullptr;
int notificationBufferWidth = 0;
int notificationBufferHeight = 0;
HFONT notificationEyebrowFont = nullptr;
HFONT notificationTitleFont = nullptr;
HFONT notificationLabelFont = nullptr;
HFONT notificationIconFont = nullptr;
bool isVsCodeWindow(HWND window, DWORD extensionHostPid);

void releaseNotificationBuffer() {
    if (notificationBuffer && notificationOldBitmap) {
        SelectObject(notificationBuffer, notificationOldBitmap);
    }
    if (notificationBitmap) DeleteObject(notificationBitmap);
    if (notificationBuffer) DeleteDC(notificationBuffer);
    notificationBuffer = nullptr;
    notificationBitmap = nullptr;
    notificationOldBitmap = nullptr;
    notificationBufferWidth = 0;
    notificationBufferHeight = 0;
}

bool ensureNotificationBuffer(HDC reference, int width, int height) {
    if (notificationBuffer && width == notificationBufferWidth && height == notificationBufferHeight) {
        return true;
    }
    releaseNotificationBuffer();
    notificationBuffer = CreateCompatibleDC(reference);
    notificationBitmap = CreateCompatibleBitmap(reference, width, height);
    if (!notificationBuffer || !notificationBitmap) {
        releaseNotificationBuffer();
        return false;
    }
    notificationOldBitmap = SelectObject(notificationBuffer, notificationBitmap);
    notificationBufferWidth = width;
    notificationBufferHeight = height;
    return true;
}

HFONT createNotificationFont(HWND window, int points, int weight) {
    const int dpi = static_cast<int>(GetDpiForWindow(window));
    // The size factor multiplies the point size as well as the geometry, or the
    // text would keep its old size inside a larger card. DPI is applied by
    // MulDiv below, so only the size factor is applied here.
    points = static_cast<int>(points * notificationSizeFactor + 0.5);
    return CreateFontW(-MulDiv(points, dpi > 0 ? dpi : 96, 72), 0, 0, 0, weight,
                       FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                       CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
}

COLORREF blend(COLORREF pale, COLORREF strong, double amount) {
    const auto channel = [amount](BYTE from, BYTE to) {
        return static_cast<BYTE>(from + (to - from) * amount);
    };
    return RGB(channel(GetRValue(pale), GetRValue(strong)),
               channel(GetGValue(pale), GetGValue(strong)),
               channel(GetBValue(pale), GetBValue(strong)));
}

void fill(HDC device, const RECT& bounds, COLORREF colour) {
    HBRUSH brush = CreateSolidBrush(colour);
    FillRect(device, &bounds, brush);
    DeleteObject(brush);
}

void drawAzurePrism(HDC device, int width) {
    constexpr COLORREF pale = RGB(216, 241, 255);
    constexpr COLORREF azure = RGB(33, 127, 189);
    const int trackHeight = sc(5);
    RECT track{0, 0, width, trackHeight};
    fill(device, track, pale);

    const ULONGLONG elapsed = GetTickCount64() - notificationAnimationStartedAt;
    const double phase = static_cast<double>(elapsed % kAzureAnimationPeriodMs)
        / static_cast<double>(kAzureAnimationPeriodMs);
    const int segmentWidth = sc(118);
    const int step = sc(3) > 0 ? sc(3) : 1;
    const int left = static_cast<int>((width + segmentWidth * 2) * phase) - segmentWidth;
    constexpr double pi = 3.14159265358979323846;
    const double intensity = 0.28 + 0.72 * (0.5 - 0.5 * std::cos(2.0 * pi * phase));
    for (int offset = 0; offset < segmentWidth; offset += step) {
        const double distance = std::abs(offset - segmentWidth / 2.0) / (segmentWidth / 2.0);
        const double strength = intensity * (1.0 - distance);
        RECT part{left + offset, 0, left + offset + step, trackHeight};
        fill(device, part, blend(pale, azure, strength));
    }
}

void drawNotificationIcon(HDC device) {
    RECT tile{sc(18), sc(21), sc(66), sc(69)};
    HBRUSH tileBrush = CreateSolidBrush(RGB(17, 26, 34));
    HGDIOBJ oldBrush = SelectObject(device, tileBrush);
    HGDIOBJ oldPen = SelectObject(device, GetStockObject(NULL_PEN));
    RoundRect(device, tile.left, tile.top, tile.right, tile.bottom, sc(14), sc(14));
    SelectObject(device, oldPen);
    SelectObject(device, oldBrush);
    DeleteObject(tileBrush);

    HGDIOBJ oldFont = SelectObject(device, notificationIconFont
        ? notificationIconFont : GetStockObject(DEFAULT_GUI_FONT));
    SetTextColor(device, RGB(255, 255, 255));
    RECT iconText = tile;
    DrawTextW(device, notificationIsCodex ? L"CX" : L"CL", -1, &iconText,
              DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(device, oldFont);
}

// The user can retune the popup without a rebuild. Anything unparseable or out of
// range falls back to the default rather than producing a popup they cannot read.
double sizeFactorFromEnvironment() {
    wchar_t buffer[32]{};
    const DWORD length = GetEnvironmentVariableW(L"AHTON_POPUP_SCALE", buffer,
                                                 static_cast<DWORD>(std::size(buffer)));
    if (length == 0 || length >= std::size(buffer)) return kDefaultSizeFactor;
    wchar_t* end = nullptr;
    const double value = std::wcstod(buffer, &end);
    if (end == buffer || !std::isfinite(value)) return kDefaultSizeFactor;
    if (value < kMinSizeFactor || value > kMaxSizeFactor) return kDefaultSizeFactor;
    return value;
}

double dpiForWorkArea(const RECT& workArea) {
    const POINT corner{workArea.right - 1, workArea.bottom - 1};
    HMONITOR monitor = MonitorFromPoint(corner, MONITOR_DEFAULTTOPRIMARY);
    UINT dpiX = 96;
    UINT dpiY = 96;
    if (monitor && SUCCEEDED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpiX, &dpiY)) && dpiX > 0) {
        return static_cast<double>(dpiX);
    }
    return 96.0;
}

BOOL CALLBACK countNotificationWindows(HWND window, LPARAM state) {
    wchar_t className[64]{};
    if (GetClassNameW(window, className, static_cast<int>(std::size(className))) &&
        std::wcscmp(className, L"AhtonNotificationWindow") == 0 &&
        IsWindowVisible(window)) {
        ++*reinterpret_cast<int*>(state);
    }
    return TRUE;
}

// Count the popups already on screen, from every VS Code window's helper, not
// just this one's. The class name is the only shared state needed, so no file,
// registry key or port has to be coordinated.
int claimNotificationSlot() {
    int occupied = 0;
    EnumWindows(countNotificationWindows, reinterpret_cast<LPARAM>(&occupied));
    return occupied % kSlotCount;
}

LRESULT CALLBACK notificationWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_CREATE: {
        if (!SetTimer(window, kNotificationTimer, kNotificationLifetimeMs, nullptr)) return -1;
        notificationShownAt = GetTickCount64();
        notificationAnimationStartedAt = notificationShownAt;
        BOOL animationsEnabled = TRUE;
        SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animationsEnabled, 0);
        if (animationsEnabled) SetTimer(window, kAnimationTimer, kAnimationFrameMs, nullptr);
        notificationEyebrowFont = createNotificationFont(window, 7, FW_BOLD);
        notificationTitleFont = createNotificationFont(window, 16, FW_BOLD);
        notificationLabelFont = createNotificationFont(window, 8, FW_SEMIBOLD);
        notificationIconFont = createNotificationFont(window, 11, FW_BOLD);
        return 0;
    }
    case WM_ERASEBKGND:
        return 1;
    case WM_MOUSEACTIVATE:
        return MA_NOACTIVATE;
    case WM_LBUTTONDOWN:
        if (GetTickCount64() - notificationShownAt >= kNotificationArmDelayMs) {
            notificationPressed = true;
            SetCapture(window);
        }
        return 0;
    case WM_LBUTTONUP:
    {
        const bool wasPressed = notificationPressed;
        notificationPressed = false;
        ReleaseCapture();
        const POINT point{static_cast<short>(LOWORD(lParam)), static_cast<short>(HIWORD(lParam))};
        RECT client{};
        GetClientRect(window, &client);
        if (wasPressed && PtInRect(&client, point)) {
            notificationOutcome = 0;
            DestroyWindow(window);
        }
        return 0;
    }
    case WM_CANCELMODE:
    case WM_CAPTURECHANGED:
        notificationPressed = false;
        return 0;
    case WM_RBUTTONUP:
    case WM_CLOSE:
        notificationOutcome = kNotificationDismissed;
        DestroyWindow(window);
        return 0;
    case WM_TIMER:
        if (wParam == kNotificationTimer) {
            notificationOutcome = kNotificationTimedOut;
            DestroyWindow(window);
        } else if (wParam == kAnimationTimer) {
            InvalidateRect(window, nullptr, FALSE);
        }
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT paint{};
        HDC device = BeginPaint(window, &paint);
        RECT bounds{};
        GetClientRect(window, &bounds);
        if (!ensureNotificationBuffer(device, bounds.right, bounds.bottom)) {
            EndPaint(window, &paint);
            return 0;
        }
        HDC canvas = notificationBuffer;
        RECT body{0, 0, bounds.right, bounds.bottom};
        fill(canvas, body, RGB(250, 252, 253));
        HPEN borderPen = CreatePen(PS_SOLID, 1, RGB(216, 229, 237));
        HGDIOBJ previousBorderPen = SelectObject(canvas, borderPen);
        HGDIOBJ previousBorderBrush = SelectObject(canvas, GetStockObject(NULL_BRUSH));
        RoundRect(canvas, 0, 0, bounds.right, bounds.bottom, sc(18), sc(18));
        SelectObject(canvas, previousBorderBrush);
        SelectObject(canvas, previousBorderPen);
        DeleteObject(borderPen);
        drawAzurePrism(canvas, bounds.right);
        SetBkMode(canvas, TRANSPARENT);
        drawNotificationIcon(canvas);

        HGDIOBJ oldFont = SelectObject(canvas, notificationEyebrowFont
            ? notificationEyebrowFont : GetStockObject(DEFAULT_GUI_FONT));
        SetTextColor(canvas, RGB(100, 116, 130));
        // No eyebrow text: the workspace name lives in the chip beside the
        // terminal label.

        SelectObject(canvas, notificationTitleFont
            ? notificationTitleFont : GetStockObject(DEFAULT_GUI_FONT));
        SetTextColor(canvas, RGB(23, 33, 43));
        RECT titleBounds{sc(82), sc(29), sc(286), sc(57)};
        DrawTextW(canvas, notificationTitle.c_str(), -1, &titleBounds,
                  DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);

        // The chip is measured to its text. A name like "Claude Wine Selling"
        // needs more room than "Terminal 3", and a fixed chip would either
        // truncate every name or leave a wide empty box around a short one.
        SelectObject(canvas, notificationLabelFont
            ? notificationLabelFont : GetStockObject(DEFAULT_GUI_FONT));
        SIZE labelSize{};
        GetTextExtentPoint32W(canvas, notificationTabLabel.c_str(),
                              static_cast<int>(notificationTabLabel.size()), &labelSize);
        const int chipLeft = sc(82);
        const int chipTextLeft = sc(91);
        // Stops short of the OPEN affordance at the right edge whatever the name.
        const int chipLimit = bounds.right - sc(100);
        int chipRight = chipTextLeft + labelSize.cx + sc(9);
        if (chipRight > chipLimit) chipRight = chipLimit;
        if (chipRight < sc(140)) chipRight = sc(140);

        HBRUSH chipBrush = CreateSolidBrush(RGB(239, 247, 251));
        HPEN chipPen = CreatePen(PS_SOLID, 1, RGB(185, 216, 233));
        HGDIOBJ previousBrush = SelectObject(canvas, chipBrush);
        HGDIOBJ previousPen = SelectObject(canvas, chipPen);
        RoundRect(canvas, chipLeft, sc(63), chipRight, sc(87), sc(8), sc(8));
        SelectObject(canvas, previousPen);
        SelectObject(canvas, previousBrush);
        DeleteObject(chipPen);
        DeleteObject(chipBrush);

        SetTextColor(canvas, RGB(34, 99, 139));
        RECT labelBounds{chipTextLeft, sc(68), chipRight - sc(8), sc(84)};
        DrawTextW(canvas, notificationTabLabel.c_str(), -1, &labelBounds,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

        SetTextColor(canvas, RGB(23, 106, 167));
        // Anchored to the right edge, not to the old 390-unit width, so the
        // affordance stays in the corner at any size factor.
        RECT openBounds{bounds.right - sc(90), sc(46), bounds.right - sc(20), sc(65)};
        DrawTextW(canvas, L"OPEN  >", -1, &openBounds, DT_RIGHT | DT_SINGLELINE);
        SetTextColor(canvas, RGB(100, 116, 130));
        RECT actionBounds{sc(18), sc(101), bounds.right - sc(18), sc(118)};
        DrawTextW(canvas, L"Click anywhere to open  |  Right-click to dismiss", -1, &actionBounds,
                  DT_LEFT | DT_SINGLELINE);
        SelectObject(canvas, oldFont);
        BitBlt(device, 0, 0, bounds.right, bounds.bottom, canvas, 0, 0, SRCCOPY);
        EndPaint(window, &paint);
        return 0;
    }
    case WM_DESTROY:
        KillTimer(window, kNotificationTimer);
        KillTimer(window, kAnimationTimer);
        releaseNotificationBuffer();
        if (notificationEyebrowFont) DeleteObject(notificationEyebrowFont);
        if (notificationTitleFont) DeleteObject(notificationTitleFont);
        if (notificationLabelFont) DeleteObject(notificationLabelFont);
        if (notificationIconFont) DeleteObject(notificationIconFont);
        notificationEyebrowFont = nullptr;
        notificationTitleFont = nullptr;
        notificationLabelFont = nullptr;
        notificationIconFont = nullptr;
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProcW(window, message, wParam, lParam);
    }
}

// The label mirrors shortLabel() in src/terminal-display-label.mjs. Both must
// agree: the extension decides what to send, and the helper decides what it is
// willing to draw. At most 28 characters, at most four words, letters digits
// spaces and a few joiners only, at least one letter, no "..". Every path
// separator, drive colon, quote and shell metacharacter is outside the set, so a
// shell-set title carrying a path or command cannot reach the card.
bool hasProviderPrefix(const wchar_t* label, size_t length) {
    // The one-letter forms: c Claude, d Codex, k Kimi. Case-insensitive by _wcsnicmp.
    const wchar_t* prefixes[] = {L"claude ", L"codex ", L"kimi ", L"c ", L"d ", L"k "};
    for (const wchar_t* prefix : prefixes) {
        const size_t prefixLength = std::wcslen(prefix);
        if (length <= prefixLength) continue;
        if (_wcsnicmp(label, prefix, prefixLength) == 0 && label[prefixLength] != L' ') return true;
    }
    return false;
}

// Shared body of isAcceptableLabel and isAcceptableWorkspace: every rule
// except the provider prefix.
bool isAcceptableText(const wchar_t* label, size_t length) {
    if (length == 0 || length > 28) return false;
    if (label[0] == L' ' || label[length - 1] == L' ') return false;
    bool hasLetter = false;
    int words = 1;
    for (size_t index = 0; index < length; ++index) {
        const wchar_t character = label[index];
        const bool letter = (character >= L'A' && character <= L'Z') ||
                            (character >= L'a' && character <= L'z');
        const bool digit = character >= L'0' && character <= L'9';
        const bool joiner = character == L'&' || character == L'.' ||
                            character == L'_' || character == L'-';
        if (character == L' ') {
            if (index > 0 && label[index - 1] == L' ') return false;
            ++words;
            continue;
        }
        if (!letter && !digit && !joiner) return false;
        if (letter) hasLetter = true;
        if (character == L'.' && index + 1 < length && label[index + 1] == L'.') return false;
    }
    return hasLetter && words <= 4;
}

bool isAcceptableLabel(const wchar_t* label) {
    if (!label) return false;
    const size_t length = std::wcslen(label);
    // Mirrors REQUIRED_LABEL_PREFIX. A shell-set title does not begin this way.
    if (length == 0 || !hasProviderPrefix(label, length)) return false;
    return isAcceptableText(label, length);
}

// Mirrors workspaceLabel() in src/terminal-display-label.mjs: the label rules
// without the provider-prefix rule, because a folder name is chosen by the
// user, not written by the agent. The extension strips " (Workspace)" first.
bool isAcceptableWorkspace(const wchar_t* workspace) {
    if (!workspace) return false;
    return isAcceptableText(workspace, std::wcslen(workspace));
}

int notify(HWND target, DWORD extensionHostPid, const wchar_t* provider, const wchar_t* reason,
           const wchar_t* displayKind, unsigned int displayIndex, const wchar_t* displayLabel,
           const wchar_t* displayWorkspace) {
    if (std::wcscmp(provider, L"codex") == 0) {
        notificationTitle = L"Codex";
        notificationIsCodex = true;
    } else if (std::wcscmp(provider, L"claude") == 0) {
        notificationTitle = L"Claude Code";
        notificationIsCodex = false;
    } else {
        return kInvalidArguments;
    }
    if (std::wcscmp(reason, L"finished") != 0 && std::wcscmp(reason, L"attention") != 0) {
        return kInvalidArguments;
    }
    if (std::wcscmp(displayKind, L"terminal") == 0 && displayIndex >= 1 && displayIndex <= 999) {
        // The label is re-checked here rather than trusted from the caller. The
        // ordinal remains the fallback, so a refused label costs recognition and
        // never the popup.
        notificationTabLabel = isAcceptableLabel(displayLabel)
            ? std::wstring(displayLabel)
            : L"Terminal " + std::to_wstring(displayIndex);
        // A workspace name leads the chip: "api <dot> Terminal 3". The middle dot
        // is built from its code point so the source stays ASCII. A refused name
        // is dropped and the chip is unchanged.
        if (isAcceptableWorkspace(displayWorkspace)) {
            notificationTabLabel = std::wstring(displayWorkspace) + L" " + wchar_t(0x00B7) + L" " +
                                   notificationTabLabel;
        }
    } else {
        return kInvalidArguments;
    }
    if (!isVsCodeWindow(target, extensionHostPid)) return kUnauthorizedWindow;

    const HINSTANCE instance = GetModuleHandleW(nullptr);
    const wchar_t* className = L"AhtonNotificationWindow";
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = notificationWindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_HAND);
    windowClass.hbrBackground = nullptr;
    windowClass.lpszClassName = className;
    if (!RegisterClassW(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return kNotificationFailed;
    }

    RECT workArea{};
    if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0)) {
        return kNotificationFailed;
    }

    notificationSizeFactor = sizeFactorFromEnvironment();
    notificationScale = (dpiForWorkArea(workArea) / 96.0) * notificationSizeFactor;

    const int width = sc(kBaseWidth);
    const int height = sc(kBaseHeight);
    const int margin = sc(kBaseMargin);
    const int gap = sc(kBaseSlotGap);

    // Claiming a slot and creating the window must not interleave with another
    // window's helper, or two popups pick the same free slot and overlap exactly
    // -- the defect this replaces. The mutex is session-local and released as
    // soon as this popup is visible and therefore countable by the next one.
    HANDLE slotLock = CreateMutexW(nullptr, FALSE, L"Local\\AhtonNotificationSlot");
    if (slotLock) WaitForSingleObject(slotLock, 2000);
    const int slot = claimNotificationSlot();
    const int x = workArea.right - width - margin;
    const int y = workArea.bottom - height - margin - slot * (height + gap);
    HWND window = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        className, notificationTitle.c_str(), WS_POPUP,
        x, y, width, height, nullptr, nullptr, instance, nullptr);
    if (!window) {
        if (slotLock) { ReleaseMutex(slotLock); CloseHandle(slotLock); }
        return kNotificationFailed;
    }
    HRGN roundedRegion = CreateRoundRectRgn(0, 0, width + 1, height + 1, sc(18), sc(18));
    if (roundedRegion && !SetWindowRgn(window, roundedRegion, FALSE)) {
        DeleteObject(roundedRegion);
    }

    notificationOutcome = kNotificationFailed;
    notificationPressed = false;
    ShowWindow(window, SW_SHOWNOACTIVATE);
    SetWindowPos(window, HWND_TOPMOST, x, y, width, height,
                 SWP_NOACTIVATE | SWP_SHOWWINDOW);
    UpdateWindow(window);
    // The click guard counts from the moment the popup is visible. WM_CREATE
    // set this earlier, and resetting it to zero made the guard compare against
    // uptime, so it was always open.
    notificationShownAt = GetTickCount64();
    // Visible, so the next helper counts it and takes the slot above.
    if (slotLock) { ReleaseMutex(slotLock); CloseHandle(slotLock); }

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return notificationOutcome;
}

bool parseDecimal(const wchar_t* value, unsigned long long& result, bool allowZero) {
    if (value == nullptr || *value == L'\0') {
        return false;
    }
    for (const wchar_t* cursor = value; *cursor != L'\0'; ++cursor) {
        if (*cursor < L'0' || *cursor > L'9') return false;
    }
    wchar_t* end = nullptr;
    errno = 0;
    const unsigned long long parsed = std::wcstoull(value, &end, 10);
    if (errno != 0 || end == value || *end != L'\0' || (!allowZero && parsed == 0)) {
        return false;
    }
    result = parsed;
    return true;
}

std::unordered_map<DWORD, DWORD> processParents() {
    std::unordered_map<DWORD, DWORD> parents;
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return parents;
    }

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            parents.emplace(entry.th32ProcessID, entry.th32ParentProcessID);
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return parents;
}

bool isAncestor(DWORD ancestorPid, DWORD descendantPid) {
    const auto parents = processParents();
    DWORD current = descendantPid;
    for (int depth = 0; depth < 64 && current != 0; ++depth) {
        if (current == ancestorPid) {
            return true;
        }
        const auto parent = parents.find(current);
        if (parent == parents.end() || parent->second == current) {
            return false;
        }
        current = parent->second;
    }
    return false;
}

bool isVsCodeWindow(HWND window, DWORD extensionHostPid) {
    if (!IsWindow(window) || !IsWindowVisible(window)) {
        return false;
    }

    wchar_t className[64]{};
    if (GetClassNameW(window, className, static_cast<int>(std::size(className))) == 0
        || std::wstring(className) != L"Chrome_WidgetWin_1") {
        return false;
    }

    DWORD ownerPid = 0;
    GetWindowThreadProcessId(window, &ownerPid);
    return ownerPid != 0 && isAncestor(ownerPid, extensionHostPid);
}

bool forceForeground(HWND target) {
    const HWND foreground = GetForegroundWindow();
    if (foreground == target) {
        return true;
    }

    const DWORD currentThread = GetCurrentThreadId();
    const DWORD foregroundThread = foreground != nullptr
        ? GetWindowThreadProcessId(foreground, nullptr)
        : 0;
    const DWORD targetThread = GetWindowThreadProcessId(target, nullptr);

    // AttachThreadInput requires the caller to own an input queue.
    MSG message{};
    PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);

    const BOOL attachedToForeground = foregroundThread != 0 && foregroundThread != currentThread
        ? AttachThreadInput(currentThread, foregroundThread, TRUE)
        : FALSE;
    const BOOL attachedToTarget = targetThread != 0 && targetThread != currentThread
        ? AttachThreadInput(currentThread, targetThread, TRUE)
        : FALSE;

    if (IsIconic(target)) {
        ShowWindowAsync(target, SW_RESTORE);
    }
    BringWindowToTop(target);
    SetForegroundWindow(target);
    SetActiveWindow(target);
    SetFocus(target);

    if (attachedToTarget) {
        AttachThreadInput(currentThread, targetThread, FALSE);
    }
    if (attachedToForeground) {
        AttachThreadInput(currentThread, foregroundThread, FALSE);
    }

    Sleep(150);
    return GetForegroundWindow() == target;
}

int capture(DWORD extensionHostPid) {
    const HWND foreground = GetForegroundWindow();
    if (!isVsCodeWindow(foreground, extensionHostPid)) {
        return kCaptureUnavailable;
    }
    std::wcout << reinterpret_cast<UINT_PTR>(foreground) << std::endl;
    return 0;
}

int focus(HWND target, DWORD extensionHostPid) {
    if (!IsWindow(target)) {
        return kInvalidWindow;
    }
    if (!isVsCodeWindow(target, extensionHostPid)) {
        return kUnauthorizedWindow;
    }
    return forceForeground(target) ? 0 : kFocusFailed;
}

bool parseUnsigned(const wchar_t* value, unsigned long long& result) {
    return parseDecimal(value, result, false);
}

bool parseNonNegative(const wchar_t* value, unsigned long long& result) {
    return parseDecimal(value, result, true);
}

int verify(HWND target, DWORD extensionHostPid) {
    if (!IsWindow(target)) return kInvalidWindow;
    if (!isVsCodeWindow(target, extensionHostPid)) return kUnauthorizedWindow;
    return GetForegroundWindow() == target ? 0 : kFocusFailed;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    // Declared in code rather than a manifest so the pinned binary stays a single
    // file. Without it Windows stretches the popup's 96-DPI bitmap on a scaled
    // display and the card is blurred. The focus path uses no coordinates, so
    // this changes drawing only. An older Windows without the entry point simply
    // keeps the previous unaware behaviour.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (argc < 3) {
        return kInvalidArguments;
    }

    unsigned long long extensionHostValue = 0;
    if (std::wcscmp(argv[1], L"capture") == 0 && argc == 3
        && parseUnsigned(argv[2], extensionHostValue)
        && extensionHostValue <= MAXDWORD) {
        return capture(static_cast<DWORD>(extensionHostValue));
    }

    unsigned long long windowValue = 0;
    unsigned long long displayIndexValue = 0;
    // Eight arguments is the ordinal-only form. Nine adds the short label. Ten
    // adds the workspace name; an empty argv[8] then means no label.
    if (std::wcscmp(argv[1], L"notify") == 0 && (argc == 8 || argc == 9 || argc == 10)
        && parseUnsigned(argv[2], windowValue)
        && parseUnsigned(argv[3], extensionHostValue)
        && parseNonNegative(argv[7], displayIndexValue)
        && extensionHostValue <= MAXDWORD
        && displayIndexValue <= 999) {
        return notify(reinterpret_cast<HWND>(static_cast<UINT_PTR>(windowValue)),
                      static_cast<DWORD>(extensionHostValue), argv[4], argv[5], argv[6],
                      static_cast<unsigned int>(displayIndexValue),
                      argc >= 9 && argv[8][0] != L'\0' ? argv[8] : nullptr,
                      argc == 10 ? argv[9] : nullptr);
    }

    if (std::wcscmp(argv[1], L"focus") == 0 && argc == 4
        && parseUnsigned(argv[2], windowValue)
        && parseUnsigned(argv[3], extensionHostValue)
        && extensionHostValue <= MAXDWORD) {
        return focus(reinterpret_cast<HWND>(static_cast<UINT_PTR>(windowValue)),
                     static_cast<DWORD>(extensionHostValue));
    }

    if (std::wcscmp(argv[1], L"verify") == 0 && argc == 4
        && parseUnsigned(argv[2], windowValue)
        && parseUnsigned(argv[3], extensionHostValue)
        && extensionHostValue <= MAXDWORD) {
        return verify(reinterpret_cast<HWND>(static_cast<UINT_PTR>(windowValue)),
                      static_cast<DWORD>(extensionHostValue));
    }

    return kInvalidArguments;
}
