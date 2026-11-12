# Fréquence de l'écran sous Windows, pour l'accorder à la cadence de la vidéo.
#   -Action list -Hwnd <fenêtre>           : écran de la fenêtre, mode en cours, fréquences possibles
#   -Action set  -Device <écran> -Hz <n>   : change la fréquence (même définition, mêmes couleurs)
#   -Test                                  : demande seulement à Windows si le mode serait accepté
# Le changement n'est pas enregistré : il disparaît au redémarrage, et MultiPlex le défait en fin de lecture.
param([string]$Action = 'list', [string]$Hwnd = '0', [string]$Device = '', [int]$Hz = 0, [switch]$Test)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MpDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize, l, t, r, b, wl, wt, wr, wb, dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettingsEx(string dev, int mode, ref DEVMODE dm, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFOEX info);
}
'@

function New-DevMode {
  $dm = New-Object MpDisplay+DEVMODE
  $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][MpDisplay+DEVMODE])
  return $dm
}

if ($Action -eq 'list') {
  # L'écran sur lequel se trouve la fenêtre (le plus proche si elle est hors écran).
  $mon = [MpDisplay]::MonitorFromWindow([IntPtr][long]$Hwnd, 2)
  $info = New-Object MpDisplay+MONITORINFOEX
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][MpDisplay+MONITORINFOEX])
  if (-not [MpDisplay]::GetMonitorInfo($mon, [ref]$info)) { throw 'ecran introuvable' }
  $Device = $info.szDevice
}
if ($Device -notmatch '^\\\\\.\\DISPLAY\d{1,3}$') { throw 'ecran invalide' }

$cur = New-DevMode
if (-not [MpDisplay]::EnumDisplaySettingsEx($Device, -1, [ref]$cur, 0)) { throw 'mode en cours illisible' }

# Les modes de même définition, mêmes couleurs, même orientation, non entrelacés.
$modes = @{}
for ($i = 0; ; $i++) {
  $dm = New-DevMode
  if (-not [MpDisplay]::EnumDisplaySettingsEx($Device, $i, [ref]$dm, 0)) { break }
  if ($dm.dmPelsWidth -eq $cur.dmPelsWidth -and $dm.dmPelsHeight -eq $cur.dmPelsHeight -and $dm.dmBitsPerPel -eq $cur.dmBitsPerPel -and $dm.dmDisplayOrientation -eq $cur.dmDisplayOrientation -and ($dm.dmDisplayFlags -band 2) -eq 0 -and -not $modes.ContainsKey($dm.dmDisplayFrequency)) {
    $modes[$dm.dmDisplayFrequency] = $dm
  }
}

if ($Action -eq 'list') {
  @{ device = $Device; width = $cur.dmPelsWidth; height = $cur.dmPelsHeight; hz = $cur.dmDisplayFrequency; rates = @($modes.Keys | Sort-Object) } | ConvertTo-Json -Compress
} elseif ($Action -eq 'set') {
  if (-not $modes.ContainsKey($Hz)) { throw 'frequence indisponible' }
  $dm = $modes[$Hz]
  # 2 = CDS_TEST (simple vérification), 0 = changement immédiat, non enregistré (perdu au redémarrage).
  # Surtout pas CDS_FULLSCREEN (4) : Windows l'annule dès que ce script se termine.
  $flags = 0
  if ($Test) { $flags = 2 }
  $code = [MpDisplay]::ChangeDisplaySettingsEx($Device, [ref]$dm, [IntPtr]::Zero, $flags, [IntPtr]::Zero)
  @{ device = $Device; hz = $Hz; result = $code; test = [bool]$Test } | ConvertTo-Json -Compress
} else {
  throw 'action inconnue'
}
