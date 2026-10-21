[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$PrinterName,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BytesPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$DocumentName
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $BytesPath -PathType Leaf)) { throw "RAW byte file was not found." }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SmokehouseRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string printerName, out IntPtr printerHandle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr printerHandle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int StartDocPrinter(IntPtr printerHandle, int level, [In] DOCINFO documentInfo);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr printerHandle);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr printerHandle);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr printerHandle);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr printerHandle, byte[] bytes, int count, out int written);

  static void Check(bool successful, string operation) {
    if (!successful) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
  }

  public static int Send(string printerName, string documentName, byte[] bytes) {
    IntPtr handle = IntPtr.Zero;
    int jobId = 0;
    bool pageStarted = false;
    try {
      Check(OpenPrinter(printerName, out handle, IntPtr.Zero), "OpenPrinter");
      var doc = new DOCINFO { pDocName = documentName, pOutputFile = null, pDataType = "RAW" };
      jobId = StartDocPrinter(handle, 1, doc);
      if (jobId <= 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
      Check(StartPagePrinter(handle), "StartPagePrinter");
      pageStarted = true;
      int written;
      Check(WritePrinter(handle, bytes, bytes.Length, out written), "WritePrinter");
      if (written != bytes.Length) throw new InvalidOperationException("WritePrinter accepted only " + written + " of " + bytes.Length + " bytes");
      return jobId;
    } finally {
      if (handle != IntPtr.Zero) {
        if (pageStarted) { EndPagePrinter(handle); }
        if (jobId > 0) { EndDocPrinter(handle); }
        ClosePrinter(handle);
      }
    }
  }
}
'@

$bytes = [System.IO.File]::ReadAllBytes($BytesPath)
 $spoolWatch = [System.Diagnostics.Stopwatch]::StartNew()
$jobId = [SmokehouseRawPrinter]::Send($PrinterName, $DocumentName, $bytes)
$spoolWatch.Stop()
[pscustomobject]@{ ok = $true; jobId = $jobId; bytes = $bytes.Length; spoolMs = $spoolWatch.Elapsed.TotalMilliseconds } | ConvertTo-Json -Compress
