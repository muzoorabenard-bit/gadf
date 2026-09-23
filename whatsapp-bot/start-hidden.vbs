' Launches run.bat with no visible console window. A copy of this file is
' placed in the user's Startup folder so Windows runs it automatically at
' login; run.bat itself restarts the bot if it ever exits, so a transient
' crash doesn't need anyone to notice and re-launch it by hand.
'
' The path below is hardcoded rather than derived from this script's own
' location -- deriving it (GetParentFolderName(WScript.ScriptFullName))
' resolves to wherever THIS COPY sits, which is the Startup folder itself
' once deployed there, not the real whatsapp-bot folder, so run.bat was
' never found and nothing ever launched. If this repo ever moves, update
' this path and redeploy the Startup copy (see README/session notes).
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "C:\Users\muzoo\gadf\whatsapp-bot\run.bat", 0, False
