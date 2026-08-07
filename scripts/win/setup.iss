; Agent Society Inno Setup Script
; Requires Inno Setup 6+

#define MyAppName "Agent Society"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Open Source Community"
#define MyAppURL "https://github.com/agent-society/agent-society"
#define MyAppExeName "agent-society.exe"

[Setup]
; NOTE: The value of AppId uniquely identifies this application. Do not use the same AppId value in installers for other applications.
; (To generate a new GUID, click Tools | Generate GUID inside the IDE.)
AppId={{C8B3B3E5-7E6A-4F1C-9F8D-2A3B4C5D6E7F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
;AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
; Remove the following line to run in administrative install mode (install for all users.)
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=AgentSociety_Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Helper to copy the build output
Source: "..\..\dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; NOTE: Don't use "Flags: ignoreversion" on any shared system files

[Icons]
; Pass the user documents folder as the data directory argument
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: """{userdocs}\Agent Society Data"""
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: """{userdocs}\Agent Society Data"""; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: """{userdocs}\Agent Society Data"""; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Clean up the install directory but NOT the user data
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\modules"
Type: filesandordirs; Name: "{app}\config"
