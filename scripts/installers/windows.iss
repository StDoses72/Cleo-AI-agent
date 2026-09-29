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
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\Cleo.exe
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#Bundle}\*"; DestDir: "{tmp}\Cleo"; Flags: dontcopy recursesubdirs createallsubdirs
Source: "{tmp}\Cleo\*"; DestDir: "{app}"; Flags: external recursesubdirs createallsubdirs ignoreversion

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
  WizardForm.PreparingLabel.Caption := 'Checking bundled Python, Node and Cleo backend...';
  ExtractTemporaryFiles('{tmp}\Cleo\*');
  if not Exec(ExpandConstant('{tmp}\Cleo\resources\python\python.exe'),
    '-I -B "' + ExpandConstant('{tmp}\Cleo\resources\installer-check.py') + '"',
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := 'Cannot start the bundled runtime. Download the installer again.'
  else if ExitCode <> 0 then
    Result := 'Cleo runtime verification failed. Nothing was installed. Download a corrected installer.'
  else
    RuntimeReady := True;
end;
