Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinProbe {
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenWindowStation(string n, bool i, uint a);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessWindowStation(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string n, uint f, bool i, uint a);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc f, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    // Escapes a window title for embedding in a JSON string (backslashes, quotes, control chars).
    static string JsonEscape(string s) {
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s) {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '"') sb.Append("\\\"");
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    public static string Scan() {
        var res = new List<string>();
        IntPtr ws = OpenWindowStation("WinSta0", false, 0x02000000);
        if (ws != IntPtr.Zero) SetProcessWindowStation(ws);
        IntPtr desk = OpenDesktop("Default", 0, false, 0x02000000);

        var t = new Thread(() => {
            if (desk != IntPtr.Zero) SetThreadDesktop(desk);
            EnumWindows((hWnd, lParam) => {
                if (IsWindowVisible(hWnd)) {
                    var sb = new StringBuilder(512);
                    GetWindowText(hWnd, sb, 512);
                    string title = sb.ToString().Trim();
                    if (!string.IsNullOrEmpty(title) && title != "Program Manager") {
                        RECT r;
                        GetWindowRect(hWnd, out r);
                        int w = r.Right - r.Left;
                        int h = r.Bottom - r.Top;
                        if (w > 80 && h > 60) {
                            uint pid;
                            GetWindowThreadProcessId(hWnd, out pid);
                            string cleanTitle = JsonEscape(title);
                            res.Add(string.Format("{{\"hwnd\":\"{0}\",\"pid\":{1},\"title\":\"{2}\",\"rect\":{{\"x\":{3},\"y\":{4},\"width\":{5},\"height\":{6}}}}}",
                                hWnd.ToInt64(), pid, cleanTitle, r.Left, r.Top, w, h));
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);
        });
        t.Start();
        t.Join();
        return "[" + string.Join(",", res) + "]";
    }
}
"@ -ErrorAction SilentlyContinue

[WinProbe]::Scan()
