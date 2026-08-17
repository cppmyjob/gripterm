# Dumps the environment of whoever runs it as UTF-8 JSON.
#
# Used twice by M3.2 question (9), and the point is that it is the SAME script
# both times, so a difference in the output is a difference in the environment
# and not in the dumper:
#   * inside a terminal the editor created  -> what the editor gives its own terminals;
#   * inside a pty we created               -> what our engine would give the agent;
#   * (the third, `process.env` of the extension host, needs no script.)
#
# -NoProfile is deliberate on the caller side: a profile changes the environment
# inside the shell, and that is the shell's doing, not the editor's.
#
# The output path is derived from the script's own location and the tag has a
# default, on purpose. Measured 2026-08-17: with a mandatory parameter the editor
# terminal produced no file at all within 30 s while the identical command line
# under our own pty produced one -- and a mandatory parameter that does not
# arrive turns PowerShell into a prompt that waits forever. A default cannot
# hang, and a file named `env-unknown.json` would have said so out loud.

param([string]$Tag = 'unknown')

$map = @{}
try {
  foreach ($entry in Get-ChildItem env:) { $map[$entry.Name] = $entry.Value }
} catch {
  $map['__enumerationFailed'] = $_.Exception.Message
}

# An empty environment is not a result, it is a defect, and a file containing
# `{}` says nothing about which. Measured 2026-08-17: the Cursor run produced
# `{}` for both dumps while the identical script by hand produced 6814 bytes.
if ($map.Count -eq 0) {
  $map['__diagnostics'] = "psVersion=$($PSVersionTable.PSVersion); pid=$PID; user=$env:USERNAME; lastError=$($Error[0])"
}

$out = Join-Path (Split-Path -Parent $PSScriptRoot) "results\env-$Tag.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

$json = $map | ConvertTo-Json -Compress -Depth 3
[System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))
