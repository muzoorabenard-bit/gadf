' Launches run.bat with no visible console window. Placed in the user's
' Startup folder so Windows runs it automatically at login; run.bat itself
' restarts the bot if it ever exits, so a transient crash doesn't need
' anyone to notice and re-launch it by hand.
Set WshShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run """" & scriptDir & "\run.bat""", 0, False
