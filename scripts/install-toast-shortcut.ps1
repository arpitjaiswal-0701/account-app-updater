# install-toast-shortcut.ps1
# Makes Windows use assets\alm.ico as the ALM Automation toast icon.
#
# Why a shortcut: for unpackaged Win32 apps, Windows resolves a toast's
# AppUserModelID to a Start Menu shortcut carrying that same AUMID, and uses
# THAT shortcut's icon in the toast header. (The registry IconUri route only
# works for packaged/COM-registered apps -- which is why it showed the bread.)
#
# This creates "%AppData%\Microsoft\Windows\Start Menu\Programs\ALM Automation.lnk"
# with:  AppUserModelID = 'Adobe.ALM.Toast'  (matches appID in src/lib/notify.js)
# The shortcut alone supplies BOTH the header icon (its .ico) and the header name
# (its filename). Do NOT also register an AppUserModelId\<id>\IconUri registry key:
# that makes Windows render the header from the PNG path and it comes out cyan.
#
# NOTE: Windows caches the toast header icon PER AUMID and never refreshes it.
# To change the icon, also bump the AUMID (here + src/lib/notify.js) or the old
# cached icon sticks. (Cyan-icon saga, 2026-06.)
#        IconLocation   = assets\alm.ico
# Setting the AUMID on a .lnk needs COM IPropertyStore, so we drop to C# interop.
#
# Idempotent, HKCU/user-profile only, no admin. Re-run after changing the icon.

param(
    [string]$IconPath,
    [string]$AppId    = 'Adobe.ALM.Toast',       # AUMID; MUST match appID in src/lib/notify.js
    [string]$LnkName  = 'ALM Automation'          # Start Menu display name + toast header name
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$icoPath = if ($IconPath) { $IconPath } else { Join-Path $root 'assets\alm.ico' }
$appId   = $AppId

if (-not (Test-Path $icoPath)) {
    throw "Icon not found: $icoPath  (run convert-logo.py or register-notify-appid.ps1 first)"
}

# Shortcut target: any valid exe (clicking it is harmless). Prefer node.exe.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $root 'node_modules\node-notifier\vendor\snoreToast\snoretoast-x64.exe' }

$startMenu = [Environment]::GetFolderPath('Programs')
$lnkPath   = Join-Path $startMenu "$LnkName.lnk"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace ToastShortcut
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropertyKey { public Guid fmtid; public uint pid;
        public PropertyKey(Guid g, uint p){ fmtid = g; pid = p; } }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string n, int m);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string n, [MarshalAs(UnmanagedType.Bool)] bool r);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string n);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string n);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint c);
        void GetAt(uint i, out PropertyKey k);
        void GetValue(ref PropertyKey k, out PropVariant pv);
        void SetValue(ref PropertyKey k, ref PropVariant pv);
        void Commit();
    }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int cch, IntPtr fd, uint fl);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
        void GetHotkey(out short w);
        void SetHotkey(short w);
        void GetShowCmd(out int s);
        void SetShowCmd(int s);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int cch, out int i);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, uint r);
        void Resolve(IntPtr hwnd, uint fl);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class CShellLink { }

    public static class Installer {
        public static void Create(string lnk, string target, string icon, string appId, string desc) {
            var link  = (IShellLinkW)new CShellLink();
            link.SetPath(target);
            link.SetIconLocation(icon, 0);
            link.SetDescription(desc);

            var store = (IPropertyStore)link;
            // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
            var key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
            var pv  = new PropVariant();
            pv.vt = 31;                                   // VT_LPWSTR
            pv.p  = Marshal.StringToCoTaskMemUni(appId);
            store.SetValue(ref key, ref pv);
            store.Commit();
            Marshal.FreeCoTaskMem(pv.p);

            ((IPersistFile)link).Save(lnk, true);
        }
    }
}
"@

[ToastShortcut.Installer]::Create($lnkPath, $node, $icoPath, $appId, 'ALM Automation toast app')
Write-Host "Created shortcut: $lnkPath"
Write-Host "  AppUserModelID = $appId"
Write-Host "  Icon           = $icoPath"
Write-Host "  Target         = $node"
Write-Host "Done. Fire a test toast to verify the icon."
