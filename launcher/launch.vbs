Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(here)))
sh.CurrentDirectory = root
electron = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node_modules\electron\dist\electron.exe"
If fso.FileExists(electron) Then
    sh.Run """" & electron & """ """ & here & "\yomu.cjs""", 1, False
Else
    sh.Run """" & root & "\venv\Scripts\pythonw.exe"" """ & here & "\launcher.py""", 0, False
End If
