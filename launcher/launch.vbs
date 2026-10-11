Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(here)))
sh.CurrentDirectory = root
sh.Run """" & root & "\venv\Scripts\pythonw.exe"" """ & here & "\launcher.py""", 0, False
