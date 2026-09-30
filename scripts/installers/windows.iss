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
const
  { SYNCHRONIZE or PROCESS_QUERY_LIMITED_INFORMATION }
  ProcessWaitAccess = $00101000;
  PollMilliseconds = 50;

var
  RuntimeReady: Boolean;
  RuntimePage: TOutputProgressWizardPage;
  RuntimeCancelRequested: Boolean;
  RuntimeIndeterminate: Boolean;
  RuntimeStageLabel: String;
  RuntimeLog: String;

function OpenProcess(dwDesiredAccess: DWORD; bInheritHandle: BOOL; dwProcessId: DWORD): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function WaitForSingleObject(hHandle: THandle; dwMilliseconds: DWORD): DWORD;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function GetExitCodeProcess(hProcess: THandle; var lpExitCode: DWORD): BOOL;
  external 'GetExitCodeProcess@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';

procedure InitializeWizard;
begin
  RuntimePage := CreateOutputProgressPage('Preparing Cleo',
    'Setup is downloading Cleo and preparing its runtime. This can take several minutes.');
end;

function BootstrapFile(const Name: String): String;
begin
  Result := ExpandConstant('{tmp}\Cleo-bootstrap\') + Name;
end;

{ Purpose: Read one value from the flat progress JSON. Input: JSON text, key. Output: raw value, or '' for null. }
function ProgressField(const Json, Name: String): String;
var
  Rest: String;
  Index: Integer;
begin
  Result := '';
  Index := Pos('"' + Name + '":', Json);
  if Index = 0 then
    exit;
  Rest := Trim(Copy(Json, Index + Length(Name) + 3, MaxInt));
  if Copy(Rest, 1, 1) = '"' then begin
    Rest := Copy(Rest, 2, MaxInt);
    Index := Pos('"', Rest);
    if Index > 0 then
      Result := Copy(Rest, 1, Index - 1);
  end else begin
    Index := 1;
    while (Index <= Length(Rest)) and (Rest[Index] <> ',') and (Rest[Index] <> '}') do
      Index := Index + 1;
    Result := Trim(Copy(Rest, 1, Index - 1));
    if Result = 'null' then
      Result := '';
  end;
end;

function MegabytesText(const Bytes: Integer): String;
begin
  Result := IntToStr(Bytes div 1048576) + '.' + IntToStr((Bytes mod 1048576) div 104858) + ' MB';
end;

procedure ShowIndeterminate;
begin
  if RuntimeIndeterminate then
    exit;
  RuntimeIndeterminate := True;
  RuntimePage.SetProgress(0, 0);
  RuntimePage.ProgressBar.Style := npbstMarquee;
  RuntimePage.ProgressBar.Visible := True;
end;

procedure ShowDeterminate(const Position, Limit: Integer);
begin
  RuntimeIndeterminate := False;
  RuntimePage.SetProgress(Position, Limit);
end;

{ Purpose: Record the current stage and optionally refresh the page. Input: whether the page is visible. }
procedure ReadRuntimeProgress(const Visible: Boolean);
var
  Content: AnsiString;
  Json, StageLabel, Detail: String;
  Bytes, TotalBytes, Done, Total, Position, Limit: Integer;
begin
  if not LoadStringFromFile(BootstrapFile('progress.json'), Content) then
    exit;
  Json := String(Content);
  StageLabel := ProgressField(Json, 'label');
  if StageLabel = '' then
    exit;
  if StageLabel <> RuntimeStageLabel then
    Log('Cleo runtime stage: ' + StageLabel);
  RuntimeStageLabel := StageLabel;
  if not Visible then
    exit;
  Bytes := StrToIntDef(ProgressField(Json, 'bytes'), -1);
  TotalBytes := StrToIntDef(ProgressField(Json, 'totalBytes'), -1);
  Done := StrToIntDef(ProgressField(Json, 'done'), -1);
  Total := StrToIntDef(ProgressField(Json, 'total'), -1);
  Detail := '';
  if (Bytes >= 0) and (TotalBytes > 0) then begin
    Position := Bytes div 1024;
    Limit := TotalBytes div 1024;
    if Limit = 0 then begin
      Position := Bytes;
      Limit := TotalBytes;
    end;
    if Position > Limit then
      Position := Limit;
    Detail := MegabytesText(Bytes) + ' of ' + MegabytesText(TotalBytes) + ' (' + IntToStr(Position * 100 div Limit) + '%)';
    ShowDeterminate(Position, Limit);
  end else if (Done >= 0) and (Total > 0) then begin
    if Done > Total then
      Done := Total;
    Detail := IntToStr(Done) + ' of ' + IntToStr(Total) + ' packages';
    ShowDeterminate(Done, Total);
  end else
    ShowIndeterminate;
  RuntimePage.SetText(StageLabel, Detail);
end;

function StartBootstrap(const Wait: TExecWait; var ResultCode: Integer): Boolean;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + BootstrapFile('windows-bootstrap.ps1') +
    '" -Stage "' + ExpandConstant('{tmp}\Cleo') + '" -SourceDirectory "' + RemoveBackslash(ExpandConstant('{src}')) +
    '" -Progress "' + BootstrapFile('progress.json') + '" -Cancel "' + BootstrapFile('cancel') +
    '" -Log "' + RuntimeLog + '"', ExpandConstant('{tmp}'), SW_HIDE, Wait, ResultCode);
end;

function ReadExitMarker(var ExitCode: Integer): Boolean;
var
  Content: AnsiString;
begin
  Result := LoadStringFromFile(BootstrapFile('bootstrap.exit'), Content) and (Trim(String(Content)) <> '');
  if Result then
    ExitCode := StrToIntDef(Trim(String(Content)), 1);
end;

{ Purpose: Run the bootstrap without blocking the wizard, showing progress and accepting Cancel.
  Output: False if it did not start; ExitCode receives its exit code or the Windows error. }
function RunBootstrapWithProgress(var ExitCode: Integer): Boolean;
var
  Content: AnsiString;
  BootstrapProcess: THandle;
  Status: DWORD;
  Pid, Ticks, CancelledAt, LostAt, ResultCode: Integer;
  Finished: Boolean;
begin
  Result := StartBootstrap(ewNoWait, ResultCode);
  if not Result then begin
    ExitCode := ResultCode;
    exit;
  end;
  ExitCode := 1;
  BootstrapProcess := 0;
  Pid := 0;
  Ticks := 0;
  CancelledAt := -1;
  LostAt := -1;
  Finished := False;
  RuntimeIndeterminate := False;
  RuntimePage.SetText('Starting setup...', '');
  ShowIndeterminate;
  RuntimePage.Show;
  try
    { Progress pages hide the wizard buttons; Cancel stays available and is handled in CancelButtonClick. }
    WizardForm.CancelButton.Visible := True;
    WizardForm.CancelButton.Enabled := True;
    repeat
      Sleep(PollMilliseconds);
      Ticks := Ticks + 1;
      if (BootstrapProcess = 0) and (LostAt < 0) and LoadStringFromFile(BootstrapFile('bootstrap.pid'), Content) then begin
        Pid := StrToIntDef(Trim(String(Content)), 0);
        if Pid > 0 then begin
          BootstrapProcess := OpenProcess(ProcessWaitAccess, False, Pid);
          if BootstrapProcess = 0 then
            LostAt := Ticks;
        end;
      end;
      if BootstrapProcess <> 0 then begin
        if WaitForSingleObject(BootstrapProcess, 0) = 0 then begin
          Status := 1;
          GetExitCodeProcess(BootstrapProcess, Status);
          ExitCode := Status;
          Finished := True;
        end;
      end else if ReadExitMarker(ExitCode) then
        Finished := True
      else if (LostAt >= 0) and (Ticks - LostAt > 200) then begin
        Log('The Cleo runtime bootstrap stopped without reporting a result.');
        ExitCode := 1;
        Finished := True;
      end else if (Pid = 0) and (Ticks > 1200) and (CancelledAt < 0) then begin
        { PowerShell never ran the script, for example because policy blocks it; stop a late start too. }
        SaveStringToFile(BootstrapFile('cancel'), 'cancel', False);
        Result := False;
        ExitCode := 1460;
        Finished := True;
      end;
      if RuntimeCancelRequested and (CancelledAt < 0) then begin
        CancelledAt := Ticks;
        Log('Cancelling Cleo runtime preparation.');
        { The bootstrap and online-runtime.mjs poll this file and remove their partial files. }
        SaveStringToFile(BootstrapFile('cancel'), 'cancel', False);
        WizardForm.CancelButton.Enabled := False;
        ShowIndeterminate;
      end;
      if CancelledAt >= 0 then begin
        RuntimePage.SetText('Cancelling...', 'Stopping downloads and removing partially prepared files.');
        { Removing a partly installed Python environment can take a while; force-stop only if it hangs. }
        if (Ticks - CancelledAt = 1200) and (Pid > 0) then
          Exec(ExpandConstant('{sys}\taskkill.exe'), '/PID ' + IntToStr(Pid) + ' /T /F', '', SW_HIDE,
            ewWaitUntilTerminated, ResultCode);
        if Ticks - CancelledAt > 1300 then
          Finished := True;
      end else if Ticks mod 5 = 0 then
        ReadRuntimeProgress(True)
      else
        RuntimePage.SetText(RuntimePage.Msg1Label.Caption, RuntimePage.Msg2Label.Caption);
    until Finished;
  finally
    if BootstrapProcess <> 0 then
      CloseHandle(BootstrapProcess);
    RuntimePage.Hide;
  end;
  ReadRuntimeProgress(False);
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if (RuntimePage = nil) or (CurPageID <> RuntimePage.ID) then
    exit;
  { Setup cannot exit while the bootstrap runs; the progress loop stops it and cleans up first. }
  Cancel := False;
  if not RuntimeCancelRequested then
    RuntimeCancelRequested := MsgBox('Stop preparing Cleo? Nothing will be installed.', mbConfirmation, MB_YESNO) = IDYES;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  Started: Boolean;
begin
  Result := '';
  if RuntimeReady then exit;
  ExtractTemporaryFiles('{tmp}\Cleo-bootstrap\*');
  RuntimeLog := GetTempDir + 'Cleo-install.log';
  DeleteFile(RuntimeLog);
  DeleteFile(BootstrapFile('progress.json'));
  DeleteFile(BootstrapFile('bootstrap.pid'));
  DeleteFile(BootstrapFile('bootstrap.exit'));
  DeleteFile(BootstrapFile('cancel'));
  RuntimeStageLabel := '';
  RuntimeCancelRequested := False;
  Log('Cleo runtime log: ' + RuntimeLog);
  { Silent installs keep the blocking wait so unattended callers receive the final exit code. }
  if WizardSilent then begin
    Started := StartBootstrap(ewWaitUntilTerminated, ExitCode);
    ReadRuntimeProgress(False);
  end else
    Started := RunBootstrapWithProgress(ExitCode);
  if not Started then
    Result := 'Cannot start the installer runtime: ' + SysErrorMessage(ExitCode) + #13#10#13#10 +
      'Download the installer again.'
  else if RuntimeCancelRequested then begin
    DelTree(ExpandConstant('{tmp}\Cleo'), True, True, True);
    DeleteFile(BootstrapFile('program.zip'));
    DeleteFile(BootstrapFile('program.zip.partial'));
    Result := 'Setup was cancelled. Partially prepared files were removed.';
  end else if ExitCode <> 0 then begin
    Result := 'Cleo could not be prepared.';
    if RuntimeStageLabel <> '' then
      Result := Result + ' Failed step: ' + RuntimeStageLabel + '.';
    { ISPP treats lines that start with # as directives, so line breaks stay mid-line. }
    Result := Result + #13#10#13#10 + 'Check your internet connection and try again. Details are in the log file:' + #13#10 +
      RuntimeLog;
  end else
    RuntimeReady := True;
end;
