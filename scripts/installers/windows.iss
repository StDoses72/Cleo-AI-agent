; The same bundled runtime is tested before copying files into the installation.
[Setup]
AppId={{AD929A4D-0594-4D59-A698-5D8B26D72795}
AppName=Cleo
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Cleo
DefaultGroupName=Cleo
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19041
OutputDir={#Output}
OutputBaseFilename=Cleo-windows-x64-setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=no
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\Cleo.exe
CloseApplications=yes
RestartApplications=no

[Messages]
WelcomeLabel2=This will install Cleo on your computer.%n%nAn internet connection is required to download the application and its runtime. Your existing conversations and settings are preserved.

[Files]
Source: "{#Bootstrap}\*"; DestDir: "{tmp}\Cleo-bootstrap"; Flags: dontcopy
Source: "{tmp}\Cleo\*"; DestDir: "{app}"; ExternalSize: {#BundleSize}; Flags: external recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\Cleo"; Filename: "{app}\Cleo.exe"

[Run]
Filename: "{app}\Cleo.exe"; Description: "Open Cleo"; Flags: postinstall nowait skipifsilent unchecked

[Code]
var
  RuntimeReady: Boolean;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if RuntimeReady then exit;
  WizardForm.PreparingLabel.Caption := 'Downloading and preparing the Cleo runtime...';
  ExtractTemporaryFiles('{tmp}\Cleo-bootstrap\*');
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Cleo-bootstrap\windows-bootstrap.ps1') +
    '" -Stage "' + ExpandConstant('{tmp}\Cleo') + '" -SourceDirectory "' + ExpandConstant('{src}') + '"',
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := 'Cannot start the installer runtime. Download the installer again.'
  else if ExitCode <> 0 then
    Result := 'Runtime preparation failed. Check your internet connection and retry.'
  else
    RuntimeReady := True;
end;
