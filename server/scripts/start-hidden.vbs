' track-and-control-me backend を非表示・非同期で起動する（design.md D6）。
' pwsh -WindowStyle Hidden 単体だと起動時に一瞬コンソールが見えることがあるため、
' WScript.Shell.Run(..., 0, False) を使う。

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptsDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverDir = fso.GetParentFolderName(scriptsDir)
repoRoot = fso.GetParentFolderName(serverDir)

shell.CurrentDirectory = repoRoot
shell.Run "cmd /c npm run server", 0, False
