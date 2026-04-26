#define MyAppName "TuxPlayerX"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "eoliann"
#define MyAppExeName "TuxPlayerX.exe"

[Setup]
AppId={{TUXPLAYER-APP-ID}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\TuxPlayerX
DefaultGroupName={#MyAppName}
OutputDir=..\..\dist
OutputBaseFilename=TuxPlayerXSetup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "..\..\dist\TuxPlayerX\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch TuxPlayerX"; Flags: nowait postinstall skipifsilent
