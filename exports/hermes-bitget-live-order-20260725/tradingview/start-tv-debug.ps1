$ErrorActionPreference = "Stop"

Get-Process TradingView -ErrorAction SilentlyContinue | Stop-Process -Force

$pkg = Get-AppxPackage -Name "TradingView.Desktop"
if (-not $pkg) {
    throw "TradingView.Desktop package not found."
}

$family = $pkg.PackageFamilyName

$appId = (Get-AppxPackageManifest $pkg |
    Select-Xml "//ns:Application/@Id" -Namespace @{ns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"} |
    Select-Object -First 1).Node.Value

if (-not $appId) {
    $appId = "TradingView.Desktop"
}

$aumid = "$family!$appId"

if (-not ([System.Management.Automation.PSTypeName]'TVLauncher2').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TVLauncher2 {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        int ActivateApplication(string appUserModelId, string arguments, int options, out uint processId);
        int ActivateForFile(string appUserModelId, IntPtr itemArray, string verb, out uint processId);
        int ActivateForProtocol(string appUserModelId, IntPtr itemArray, out uint processId);
    }

    [ComImport, Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c"), ClassInterface(ClassInterfaceType.None)]
    class ApplicationActivationManager {}

    public static uint Launch(string aumid, string args) {
        var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid;
        mgr.ActivateApplication(aumid, args, 0, out pid);
        return pid;
    }
}
"@
}

$pid2 = [TVLauncher2]::Launch($aumid, "--remote-debugging-port=9222")
Write-Host "TradingView launched with debug port 9222. PID: $pid2"

Start-Sleep -Seconds 6
curl.exe http://127.0.0.1:9222/json/version
