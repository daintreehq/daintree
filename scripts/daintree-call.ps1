# `daintree call` and `daintree session` on Windows (#17932): the same client as
# the `# >>> daintree call >>>` block of scripts/daintree-cli.sh, for a system
# with no bash or awk. bin\daintree.cmd starts it with Windows PowerShell 5.1,
# which every supported Windows ships, and it runs on PowerShell 7 too, which is
# how the tests drive it off Windows.
#
# The arguments arrive in DAINTREE_CLI_ARGS, the raw text that followed
# `daintree` on the command line, and are split here the way any Windows program
# splits its own (the MSVC runtime's rules). Passed on powershell.exe's command
# line instead, -File would bind any `-name` among them as a parameter.
#
# Every exit status is offset by 40 (and 130, an interrupt, becomes 170): the
# shim maps 40-45 and 170 back, and reads anything else, such as the 1 Windows
# PowerShell exits with when a policy refuses to run this file, as the client
# never having run.
#
# HTTP is in-process, so the bearer and the request body never reach a command
# line, and nothing is written to disk. Keep this file ASCII: Windows
# PowerShell reads a script without a byte order mark in the ANSI code page.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:Command = 'call'
$script:Exiting = $false
$script:Http = $null
$script:Token = ''
$script:Endpoint = ''
$script:Session = ''
$script:Version = ''
$script:Close = $false
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:StdOut = $null
$script:StdErr = $null
$script:JsonError = ''
$script:JsonToken = New-Object System.Text.RegularExpressions.Regex (
  '\G[ \t\r\n]*(?:(?<s>"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*")|(?<l>true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(?![^ \t\r\n,\]}:])|(?<p>[{}\[\],:]))'
)
$script:JsonSpace = New-Object System.Text.RegularExpressions.Regex ('\G[ \t\r\n]*')
# A surrogate pair counts only when it is escaped as one; any other surrogate
# becomes U+FFFD, as the bash client's awk decodes them.
$script:JsonEscape = New-Object System.Text.RegularExpressions.Regex (
  '\\u([Dd][89ABab][0-9A-Fa-f]{2})\\u([Dd][C-Fc-f][0-9A-Fa-f]{2})|\\u([0-9A-Fa-f]{4})|\\(.)'
)
function ConvertFrom-DtcEscape($m, [bool]$keepNul) {
  if ($m.Groups[1].Success) {
    return [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) + [string][char][Convert]::ToInt32($m.Groups[2].Value, 16)
  }
  if ($m.Groups[3].Success) {
    $code = [Convert]::ToInt32($m.Groups[3].Value, 16)
    if ($code -ge 0xD800 -and $code -le 0xDFFF) { return [string][char]0xFFFD }
    # A value drops NUL, as the bash client's awk can't carry it. A key keeps
    # it, so "isError\u0000" stays a key of its own rather than becoming isError.
    if ($code -eq 0 -and -not $keepNul) { return '' }
    return [string][char]$code
  }
  switch -CaseSensitive ($m.Groups[4].Value) {
    'n' { return "`n" }
    't' { return "`t" }
    'r' { return "`r" }
    'b' { return [string][char]8 }
    'f' { return [string][char]12 }
    default { return $m.Groups[4].Value }
  }
}
$script:JsonUnescape = [System.Text.RegularExpressions.MatchEvaluator] { param($m) ConvertFrom-DtcEscape $m $false }
$script:JsonUnescapeKey = [System.Text.RegularExpressions.MatchEvaluator] { param($m) ConvertFrom-DtcEscape $m $true }
$script:JsonQuote = [System.Text.RegularExpressions.MatchEvaluator] {
  param($m)
  $c = [int][char]$m.Value
  if ($c -eq 34) { return '\"' }
  if ($c -eq 92) { return '\\' }
  if ($c -eq 10) { return '\n' }
  if ($c -eq 13) { return '\r' }
  if ($c -eq 9) { return '\t' }
  return '\u' + $c.ToString('x4')
}

function Get-DtcCallUsage {
  @'
Usage: daintree call <tool> [--arg key=value]... [--json]
       daintree call <tool> --args "<json object>" [--json]
       daintree call <tool> --args - [--json]    (the object on stdin)

Call one of Daintree's MCP tools from a script or a git hook, with the access
the caller already has.

In an agent pane of a project with Daintree MCP on, the pane's own credential is
used (DAINTREE_MCP_URL and DAINTREE_MCP_TOKEN), so one call can send to an agent
an earlier call launched. Anywhere else, set both from Settings > MCP server:
the key as DAINTREE_MCP_TOKEN and the server's URL as DAINTREE_MCP_URL (on
Windows the running Daintree's port isn't found by itself). That key owns only
what it creates in one session, and each call opens its own and closes it on
exit, unless DAINTREE_MCP_SESSION names a session held open by
daintree session start (see daintree session --help).

Options:
  --arg key=value   A string argument (repeatable; the value may contain '=')
  --args <json>     All arguments as one JSON object, for numbers, booleans,
                    arrays and objects. "-" reads it from stdin, which keeps a
                    prompt out of the process list and out of cmd's and
                    PowerShell's quoting: written inline, each double quote in
                    the JSON needs a backslash before it (\")
  --json            Print the whole tool result as JSON
  -h, --help        Show this help message

Exit status:
  0  the tool succeeded; its text is on stdout
  1  the tool reported an error (its text is on stderr), or Daintree refused
     the call or its session
  2  usage error
  3  no answer: Daintree isn't reachable, or the reply wasn't understood. A
     call that was already sent may have run, so check before repeating it
  4  no usable credential or endpoint: DAINTREE_MCP_TOKEN is missing,
     malformed, or refused, or DAINTREE_MCP_URL is missing or malformed
  5  the session in DAINTREE_MCP_SESSION is gone; nothing ran

Examples:
  daintree call actions.search --arg "query=send to an owned terminal"
  daintree call actions.getSchema --arg actionId=terminal.sendCommandOwned
  daintree call terminal.list --json
  daintree call agent.launch --args - < launch.json
'@
}

function Get-DtcSessionUsage {
  @'
Usage: daintree session start
       daintree session end

Hold one session open across separate daintree call processes. The Settings
API key owns only what it creates in the session it is using, so a script that
launches an agent with one call and sends to it with the next needs both calls
in one session. In PowerShell:

  $handle = daintree session start
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $env:DAINTREE_MCP_SESSION = $handle
  daintree call agent.launch --arg agentId=claude --json
  cmd /c "daintree call terminal.sendCommandOwned --args - < send.json"
  daintree session end
  Remove-Item Env:DAINTREE_MCP_SESSION

where send.json is {"terminalId": "<the launch's terminalId>", "command": "..."}.

start opens a session with DAINTREE_MCP_TOKEN and DAINTREE_MCP_URL, as for
daintree call, and prints its handle, refusing while DAINTREE_MCP_SESSION names
one already. Every daintree call made with the handle in DAINTREE_MCP_SESSION
runs in that session; end closes it. The handle holds no credential and is
useless without the one that opened it.

The session ends with end, after 30 minutes without a call (time asleep
doesn't count), or when Daintree's MCP server stops, restarts or changes its
key. What it created stays where it is, owned by no session, and a later call
with the handle fails (exit 5, or 4 for a changed key, 3 while Daintree isn't
answering) rather than open a new session in its place. Within 120 seconds, a
repeated creation call with the same arguments in the same session can get the
first call's answer back instead of creating again; give each its own
requestKey to create two.

In an agent pane the pane's credential already owns what its calls create, so
a held session adds nothing there. It holds one of the pane's eight sessions
until it ends or the pane exits, and a ninth can evict it.

Exit status:
  0  done; start prints the handle on stdout
  1  Daintree refused the session
  2  usage error: DAINTREE_MCP_SESSION already names a session for start, or
     is missing or malformed for end
  3  no answer: Daintree isn't reachable, or the reply wasn't understood
  4  no usable credential or endpoint, as for daintree call
  5  the session in DAINTREE_MCP_SESSION is gone
'@
}

# Text to stdout or stderr: UTF-8 when redirected, as the agent or script that
# captures it reads it, and the console's own encoding when it is a console.
function Write-DtcText([string]$text, [bool]$toErr) {
  if ($toErr) {
    if ([Console]::IsErrorRedirected) {
      if ($null -eq $script:StdErr) { $script:StdErr = [Console]::OpenStandardError() }
      $bytes = $script:Utf8.GetBytes($text)
      $script:StdErr.Write($bytes, 0, $bytes.Length)
      $script:StdErr.Flush()
    } else {
      [Console]::Error.Write($text)
    }
  } else {
    if ([Console]::IsOutputRedirected) {
      if ($null -eq $script:StdOut) { $script:StdOut = [Console]::OpenStandardOutput() }
      $bytes = $script:Utf8.GetBytes($text)
      $script:StdOut.Write($bytes, 0, $bytes.Length)
      $script:StdOut.Flush()
    } else {
      [Console]::Out.Write($text)
    }
  }
}

# A diagnostic that can't be written is dropped: the status still says it.
function Write-DtcError([string]$text) {
  try { Write-DtcText $text $true } catch { }
}

function Exit-Dtc([int]$code) {
  $script:Exiting = $true
  exit (40 + $code)
}

function Stop-Dtc([int]$code, [string]$message) {
  Write-DtcError ('daintree ' + $script:Command + ': ' + $message + "`n")
  Exit-Dtc $code
}

# The arguments as the MSVC runtime splits a command line (2008 and later), so
# the client sees exactly the argv any native program would get from it.
function Split-DtcCommandLine([string]$line) {
  $list = New-Object System.Collections.Generic.List[string]
  $sb = New-Object System.Text.StringBuilder
  $quoted = $false
  $have = $false
  $i = 0
  $n = $line.Length
  while ($i -lt $n) {
    $c = $line[$i]
    if (-not $quoted -and ($c -ceq ' ' -or $c -ceq "`t")) {
      if ($have) { $list.Add($sb.ToString()); [void]$sb.Clear(); $have = $false }
      $i++
      continue
    }
    $have = $true
    if ($c -ceq '\') {
      $j = $i
      while ($j -lt $n -and $line[$j] -ceq '\') { $j++ }
      $count = $j - $i
      if ($j -lt $n -and $line[$j] -ceq '"') {
        [void]$sb.Append([char]'\', [int][Math]::Floor($count / 2))
        if ($count % 2 -eq 1) { [void]$sb.Append([char]'"'); $i = $j + 1 } else { $i = $j }
      } else {
        [void]$sb.Append([char]'\', $count)
        $i = $j
      }
      continue
    }
    if ($c -ceq '"') {
      # Inside quotes, a doubled quote is one literal quote.
      if ($quoted -and $i + 1 -lt $n -and $line[$i + 1] -ceq '"') {
        [void]$sb.Append([char]'"')
        $i += 2
        continue
      }
      $quoted = -not $quoted
      $i++
      continue
    }
    [void]$sb.Append($c)
    $i++
  }
  if ($have) { $list.Add($sb.ToString()) }
  return , $list
}

function ConvertTo-DtcJsonString([string]$s) {
  return '"' + [System.Text.RegularExpressions.Regex]::Replace($s, '[\\"\x00-\x1f]', $script:JsonQuote) + '"'
}

# Why the string at `at` isn't valid, for a diagnostic.
function Get-DtcStringProblem([string]$text, [int]$at) {
  $i = $at + 1
  while ($i -lt $text.Length) {
    $c = [int]$text[$i]
    if ($c -eq 34) { return 'bad string' }
    if ($c -eq 92) {
      if ($i + 1 -ge $text.Length) { return 'unterminated string' }
      $e = $text[$i + 1]
      if ($e -ceq 'u') {
        if ($i + 5 -ge $text.Length -or $text.Substring($i + 2, 4) -cnotmatch '^[0-9A-Fa-f]{4}\z') { return 'bad \u escape' }
        $i += 6
        continue
      }
      if ('"\/bfnrt'.IndexOf($e) -lt 0) { return 'bad escape' }
      $i += 2
      continue
    }
    if ($c -lt 32) { return 'control character in a string' }
    $i++
  }
  return 'unterminated string'
}

# A strict JSON reader that keeps where each value sits in the text, so the
# result can be printed exactly as Daintree sent it. Each value is a hashtable:
# T (object, array, string, number, true, false, null), S and E (its span, E
# exclusive), and K (an ordinal, case-sensitive key map) or A (the items).
# Returns $null and sets $script:JsonError for anything malformed. Iterative,
# so nesting is bounded by the depth check rather than PowerShell's call depth.
function Read-DtcJson([string]$text) {
  $script:JsonError = ''
  $len = $text.Length
  $pos = 0
  $stack = New-Object System.Collections.Generic.List[hashtable]
  $root = $null
  $state = 'value'
  while ($true) {
    $m = $script:JsonToken.Match($text, $pos)
    $top = $null
    if ($stack.Count -gt 0) { $top = $stack[$stack.Count - 1] }
    if (-not $m.Success) {
      $q = $pos + $script:JsonSpace.Match($text, $pos).Length
      if ($q -ge $len) {
        if ($state -ceq 'done') { return $root }
        $script:JsonError = 'unexpected end of input'
      } elseif ($state -ceq 'done') {
        $script:JsonError = 'unexpected data after the value'
      } elseif ($state -ceq 'colon') {
        $script:JsonError = 'expected a colon'
      } elseif ($state -ceq 'next') {
        if ($top.Node.T -ceq 'object') { $script:JsonError = 'expected a comma or a closing brace' } else { $script:JsonError = 'expected a comma or a closing bracket' }
      } elseif ($text[$q] -ceq '"') {
        $script:JsonError = Get-DtcStringProblem $text $q
      } elseif ($state -ceq 'key' -or $state -ceq 'keyOrClose') {
        $script:JsonError = 'expected a key'
      } else {
        $end = $q
        while ($end -lt $len -and $end - $q -lt 20 -and " `t`r`n,]}:".IndexOf($text[$end]) -lt 0) { $end++ }
        $script:JsonError = 'unexpected ' + $text.Substring($q, $end - $q)
      }
      return $null
    }
    $pos = $m.Index + $m.Length
    $string = $m.Groups['s']
    $literal = $m.Groups['l']
    $punct = ''
    if ($m.Groups['p'].Success) { $punct = $m.Groups['p'].Value }

    if ($state -ceq 'done') { $script:JsonError = 'unexpected data after the value'; return $null }
    if ($state -ceq 'colon') {
      if ($punct -ceq ':') { $state = 'value'; continue }
      $script:JsonError = 'expected a colon'
      return $null
    }
    if ($state -ceq 'next') {
      if ($punct -ceq ',') {
        if ($top.Node.T -ceq 'object') { $state = 'key' } else { $state = 'value' }
        continue
      }
      if (($punct -ceq '}' -and $top.Node.T -ceq 'object') -or ($punct -ceq ']' -and $top.Node.T -ceq 'array')) {
        $top.Node.E = $pos
        $stack.RemoveAt($stack.Count - 1)
        if ($stack.Count -eq 0) { $state = 'done' } else { $state = 'next' }
        continue
      }
      if ($top.Node.T -ceq 'object') { $script:JsonError = 'expected a comma or a closing brace' } else { $script:JsonError = 'expected a comma or a closing bracket' }
      return $null
    }
    if ($state -ceq 'key' -or $state -ceq 'keyOrClose') {
      if ($state -ceq 'keyOrClose' -and $punct -ceq '}') {
        $top.Node.E = $pos
        $stack.RemoveAt($stack.Count - 1)
        if ($stack.Count -eq 0) { $state = 'done' } else { $state = 'next' }
        continue
      }
      if (-not $string.Success) { $script:JsonError = 'expected a key'; return $null }
      $top.Key = Get-DtcStringValue $text @{ S = $string.Index; E = $string.Index + $string.Length } $true
      $state = 'colon'
      continue
    }
    if ($state -ceq 'valueOrClose' -and $punct -ceq ']') {
      $top.Node.E = $pos
      $stack.RemoveAt($stack.Count - 1)
      if ($stack.Count -eq 0) { $state = 'done' } else { $state = 'next' }
      continue
    }
    # A value.
    if ($stack.Count -gt 200) { $script:JsonError = 'nested too deep'; return $null }
    $node = $null
    if ($string.Success) {
      $node = @{ T = 'string'; S = $string.Index; E = $string.Index + $string.Length }
    } elseif ($literal.Success) {
      $kind = $literal.Value
      if ($kind -cne 'true' -and $kind -cne 'false' -and $kind -cne 'null') { $kind = 'number' }
      $node = @{ T = $kind; S = $literal.Index; E = $literal.Index + $literal.Length }
    } elseif ($punct -ceq '{') {
      $node = @{ T = 'object'; S = $pos - 1; E = -1; K = (New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::Ordinal)) }
    } elseif ($punct -ceq '[') {
      $node = @{ T = 'array'; S = $pos - 1; E = -1; A = (New-Object System.Collections.Generic.List[object]) }
    } else {
      $script:JsonError = 'unexpected ' + $punct
      return $null
    }
    if ($null -eq $top) {
      $root = $node
    } elseif ($top.Node.T -ceq 'object') {
      $top.Node.K[$top.Key] = $node
    } else {
      $top.Node.A.Add($node)
    }
    if ($node.T -ceq 'object') {
      $stack.Add(@{ Node = $node; Key = $null })
      $state = 'keyOrClose'
    } elseif ($node.T -ceq 'array') {
      $stack.Add(@{ Node = $node; Key = $null })
      $state = 'valueOrClose'
    } elseif ($stack.Count -eq 0) {
      $state = 'done'
    } else {
      $state = 'next'
    }
  }
}

function Get-DtcRaw([string]$text, $node) {
  return $text.Substring($node.S, $node.E - $node.S)
}

# A string's text, decoded; $node spans it with its quotes. `isKey` keeps NUL.
function Get-DtcStringValue([string]$text, $node, [bool]$isKey = $false) {
  $inner = $text.Substring($node.S + 1, $node.E - $node.S - 2)
  if ($inner.IndexOf([char]'\') -lt 0) { return $inner }
  if ($isKey) { return $script:JsonEscape.Replace($inner, $script:JsonUnescapeKey) }
  return $script:JsonEscape.Replace($inner, $script:JsonUnescape)
}

function Get-DtcMember($node, [string]$key) {
  if ($null -eq $node -or $node.T -cne 'object' -or -not $node.K.ContainsKey($key)) { return $null }
  return $node.K[$key]
}

function Test-DtcType($node, [string]$type) {
  return ($null -ne $node -and $node.T -ceq $type)
}

# The JSON-RPC response whose id is `want` in one reply body, plain JSON or an
# SSE stream: @{ Root; Text } for a well-formed one, or $null.
# The body's lines as awk reads them: split on LF, one trailing CR off each.
function Get-DtcLines([string]$body) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in $body.Split([char]10)) {
    if ($line.Length -gt 0 -and $line[$line.Length - 1] -ceq "`r") { $line = $line.Substring(0, $line.Length - 1) }
    $lines.Add($line)
  }
  return , $lines
}

function Find-DtcResponse([string]$body, [string]$want) {
  $lines = Get-DtcLines $body
  $sse = $false
  foreach ($line in $lines) {
    if ($line -cmatch '^(data|event|id|retry):') { $sse = $true; break }
  }
  if (-not $sse) { return (Test-DtcEvent ([string]::Join("`n", $lines.ToArray())) $want) }
  $data = New-Object System.Text.StringBuilder
  $has = $false
  foreach ($line in $lines) {
    if ($line -ceq '') {
      if ($has) {
        $found = Test-DtcEvent $data.ToString() $want
        if ($null -ne $found) { return $found }
      }
      [void]$data.Clear()
      $has = $false
      continue
    }
    if ($line -cmatch '^data:') {
      $value = $line.Substring(5)
      if ($value.Length -gt 0 -and $value[0] -ceq ' ') { $value = $value.Substring(1) }
      if ($has) { [void]$data.Append("`n") }
      [void]$data.Append($value)
      $has = $true
    }
  }
  if ($has) { return (Test-DtcEvent $data.ToString() $want) }
  return $null
}

function Test-DtcEvent([string]$data, [string]$want) {
  if ($data -ceq '') { return $null }
  $root = Read-DtcJson $data
  if (-not (Test-DtcType $root 'object')) { return $null }
  $version = Get-DtcMember $root 'jsonrpc'
  if (-not (Test-DtcType $version 'string') -or (Get-DtcStringValue $data $version) -cne '2.0') { return $null }
  $id = Get-DtcMember $root 'id'
  if (-not (Test-DtcType $id 'number')) { return $null }
  # .NET Framework refuses a number past the double range where .NET reads it as
  # infinity: either way it isn't the id asked for.
  $invariant = [System.Globalization.CultureInfo]::InvariantCulture
  $float = [System.Globalization.NumberStyles]::Float
  $got = 0.0
  $asked = 0.0
  if (-not [double]::TryParse((Get-DtcRaw $data $id), $float, $invariant, [ref]$got) -or [double]::IsInfinity($got)) { return $null }
  if (-not [double]::TryParse($want, $float, $invariant, [ref]$asked) -or $got -ne $asked) { return $null }
  if ((Test-DtcType (Get-DtcMember $root 'result') 'object') -eq (Test-DtcType (Get-DtcMember $root 'error') 'object')) { return $null }
  return @{ Root = $root; Text = $data }
}

# A JSON-RPC error's words, as the bash client prints them.
function Get-DtcRpcError($found) {
  $rpc = Get-DtcMember $found.Root 'error'
  $message = Get-DtcMember $rpc 'message'
  $code = Get-DtcMember $rpc 'code'
  $text = 'JSON-RPC error'
  if (Test-DtcType $message 'string') { $text = Get-DtcStringValue $found.Text $message }
  if (Test-DtcType $code 'number') { $text += ' (code ' + (Get-DtcRaw $found.Text $code) + ')' }
  return $text
}

# A refused handshake or call: one JSON body carrying a JSON-RPC error, whatever
# its id. The error's words, or $null when the body is anything else.
function Get-DtcRefusal([string]$body) {
  $text = [string]::Join("`n", (Get-DtcLines $body).ToArray())
  $root = Read-DtcJson $text
  if (-not (Test-DtcType $root 'object')) { return $null }
  $version = Get-DtcMember $root 'jsonrpc'
  if (-not (Test-DtcType $version 'string') -or (Get-DtcStringValue $text $version) -cne '2.0') { return $null }
  if (-not (Test-DtcType (Get-DtcMember (Get-DtcMember $root 'error') 'message') 'string')) { return $null }
  return (Get-DtcRpcError @{ Root = $root; Text = $text })
}

function Get-DtcExcerpt([string]$body) {
  $clean = [System.Text.RegularExpressions.Regex]::Replace($body, '[\x00-\x08\x0b-\x1f]', '')
  if ($clean.Length -gt 300) { $clean = $clean.Substring(0, 300) }
  return $clean
}

function Get-DtcFailure($task) {
  if ($task.IsCanceled) { return 'no answer in time' }
  $e = $task.Exception
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  $detail = Get-DtcExcerpt $e.Message
  if ($detail -ceq '') { return 'the request failed' }
  return $detail
}

# Waits on a task in short steps, so Ctrl+C can stop the script between them.
# False once `deadline` (a Stopwatch timestamp; 0 for none) has passed, without waiting
# for the task: the caller cancels the request, which aborts it.
function Wait-DtcTask($task, [long]$deadline) {
  while (-not $task.IsCompleted) {
    if ($deadline -gt 0 -and [System.Diagnostics.Stopwatch]::GetTimestamp() -gt $deadline) { return $false }
    try { [void]$task.Wait(100) } catch { }
  }
  return $true
}

function Initialize-DtcHttp {
  Add-Type -AssemblyName System.Net.Http
  # .NET Framework's default: a body waits on a 100 Continue the server never sends.
  [System.Net.ServicePointManager]::Expect100Continue = $false
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $handler.AllowAutoRedirect = $false
  $handler.UseCookies = $false
  # The handler alone, not an HttpClient: HttpClient disposes the token source
  # it links the caller's token into once the headers arrive, after which, on
  # .NET Framework, cancelling no longer aborts the body's read. The handler
  # returns at the headers either way, its content still streaming.
  $script:Http = New-Object System.Net.Http.HttpMessageInvoker($handler, $true)
}

# One request to the endpoint: a POST of `body`, or with none, the DELETE that
# ends the session. `timeoutMs` bounds the whole exchange, body included (0: no
# limit, since a call can wait on an approval or an agent). With `adopt`, a
# session id in the headers is filed before the body is read, so a reply that
# never completes still leaves the session to be closed. Returns @{ Status (0
# when no headers arrived); Body; Error ('' when the exchange completed) }.
function Invoke-DtcRequest([string]$body, [int]$timeoutMs, [bool]$adopt) {
  $result = @{ Status = 0; Body = ''; Error = '' }
  $late = 'no answer within ' + [int]($timeoutMs / 1000) + ' seconds'
  $complete = $false
  $method = [System.Net.Http.HttpMethod]::Delete
  if ($body -cne '') { $method = [System.Net.Http.HttpMethod]::Post }
  $request = New-Object System.Net.Http.HttpRequestMessage($method, $script:Endpoint)
  $cts = New-Object System.Threading.CancellationTokenSource
  $response = $null
  $stream = $null
  $deadline = 0
  if ($timeoutMs -gt 0) {
    $cts.CancelAfter($timeoutMs)
    $deadline = [System.Diagnostics.Stopwatch]::GetTimestamp() + [long]($timeoutMs * [System.Diagnostics.Stopwatch]::Frequency / 1000)
  }
  try {
    [void]$request.Headers.TryAddWithoutValidation('Authorization', 'Bearer ' + $script:Token)
    [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
    $request.Headers.ExpectContinue = $false
    if ($script:Session -cne '') { [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $script:Session) }
    if ($script:Version -cne '') { [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', $script:Version) }
    if ($body -cne '') {
      $content = New-Object System.Net.Http.ByteArrayContent(, $script:Utf8.GetBytes($body))
      $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/json')
      $request.Content = $content
    }
    $send = $script:Http.SendAsync($request, $cts.Token)
    if (-not (Wait-DtcTask $send $deadline)) { $result.Error = $late; return $result }
    if ($send.IsFaulted -or $send.IsCanceled) {
      $result.Error = Get-DtcFailure $send
      if ($send.IsCanceled -and $timeoutMs -gt 0) { $result.Error = $late }
      return $result
    }
    $response = $send.Result
    $result.Status = [int]$response.StatusCode
    $values = $null
    if ($adopt -and $script:Session -ceq '' -and $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) {
      # The last one, as the bash client reads a repeated header.
      $id = [string](@($values)[-1])
      $id = $id.Trim()
      if ($id -cmatch '^[!-~]+\z') { $script:Session = $id }
    }
    $open = $response.Content.ReadAsStreamAsync()
    if (-not (Wait-DtcTask $open $deadline)) { $result.Error = $late; return $result }
    if ($open.IsFaulted -or $open.IsCanceled) {
      $result.Error = Get-DtcFailure $open
      return $result
    }
    $stream = $open.Result
    $buffer = New-Object byte[] 65536
    $bytes = New-Object System.IO.MemoryStream
    while ($true) {
      # Checked on every read, not only on a stalled one: a body that keeps
      # trickling in must still end at the deadline.
      if ($deadline -gt 0 -and [System.Diagnostics.Stopwatch]::GetTimestamp() -gt $deadline) { $result.Error = $late; return $result }
      $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
      if (-not (Wait-DtcTask $read $deadline)) { $result.Error = $late; return $result }
      if ($read.IsFaulted -or $read.IsCanceled) {
        $result.Error = Get-DtcFailure $read
        return $result
      }
      if ($read.Result -eq 0) { break }
      $bytes.Write($buffer, 0, $read.Result)
    }
    # .NET Framework can end a body cut short as if it were complete.
    $declared = $response.Content.Headers.ContentLength
    if ($null -ne $declared -and $bytes.Length -lt $declared) {
      $result.Error = 'the reply was cut short'
      return $result
    }
    $result.Body = $script:Utf8.GetString($bytes.ToArray())
    $complete = $true
    return $result
  } finally {
    # An exchange cut off by the deadline, an error or Ctrl+C is cancelled
    # first: on .NET Framework that aborts the connection, where disposing a
    # half-read response would try to drain it.
    if (-not $complete) { try { $cts.Cancel() } catch { } }
    if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
    if ($null -ne $response) { try { $response.Dispose() } catch { } }
    try { $request.Dispose() } catch { }
    try { $cts.Dispose() } catch { }
  }
}

# Runs on every way out, Ctrl+C included. It closes only a session this
# process opened and hasn't handed over, never a held one.
function Close-Dtc {
  if ($null -eq $script:Http) { return }
  if ($script:Close -and $script:Session -cne '') {
    # Best effort and bounded: a refused DELETE must not read as a failed call.
    try { [void](Invoke-DtcRequest '' 2000 $false) } catch { }
  }
  try { $script:Http.Dispose() } catch { }
  $script:Http = $null
  $script:Session = ''
}

function Assert-DtcAuthorized($result) {
  if ($result.Status -eq 401) {
    Stop-Dtc 4 "Daintree refused DAINTREE_MCP_TOKEN (HTTP 401). A pane's credential ends with its agent; outside a pane, use the key from Settings > MCP server."
  }
}

# The server answers 404 for a session it doesn't have, or that another
# credential opened, before the request reaches it.
function Assert-DtcSessionLive($result) {
  if ($result.Status -eq 404) {
    Stop-Dtc 5 "the session in DAINTREE_MCP_SESSION is gone: it was ended, went 30 minutes without a call, was evicted, was dropped when Daintree's MCP server restarted, or belongs to another credential. Nothing ran, and no new session was opened; clear DAINTREE_MCP_SESSION and start another with daintree session start."
  }
}

# The session a handle from `daintree session start` names: the protocol
# version negotiated when it opened, a colon, then its id.
function Read-DtcHandle([string]$handle) {
  $colon = $handle.IndexOf([char]':')
  $version = ''
  $session = ''
  if ($colon -ge 0) {
    $version = $handle.Substring(0, $colon)
    $session = $handle.Substring($colon + 1)
  }
  if ($colon -lt 0 -or $version -cnotmatch '^[0-9A-Za-z.-]+\z' -or $session -cnotmatch '^[!-~]+\z') {
    Stop-Dtc 2 "DAINTREE_MCP_SESSION isn't a handle printed by daintree session start"
  }
  return @{ Version = $version; Session = $session }
}

# A JSON-RPC id no other call in a held session is using. Each call there is a
# process of its own, so nothing can count; 52 random bits with bit 52 set stay
# below 2^53, exact through JSON.parse, and never meet the handshake's 1.
function New-DtcRequestId {
  $bytes = New-Object byte[] 8
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $value = ([BitConverter]::ToInt64($bytes, 0) -band [long]0xFFFFFFFFFFFFF) -bor [long]0x10000000000000
  return $value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
}

# What every request needs: the bearer and the endpoint from the environment,
# and the HTTP client. Loopback only, so the bearer never leaves the machine
# whatever the environment says, and always 127.0.0.1, the address Daintree
# binds: `localhost` can resolve to ::1, where something else may listen on the
# same port. Claude's Assistant pane is handed the legacy /sse URL; the same
# listener and bearer serve Streamable HTTP at /mcp.
function Initialize-Dtc {
  $token = [string]$env:DAINTREE_MCP_TOKEN
  $url = [string]$env:DAINTREE_MCP_URL
  if ($token -ceq '') {
    Stop-Dtc 4 'DAINTREE_MCP_TOKEN is not set. Run it in an agent pane of a project with Daintree MCP on, or export the key from Settings > MCP server as DAINTREE_MCP_TOKEN (with DAINTREE_MCP_URL too, for a dev build or another profile).'
  }
  # Printable ASCII only: .NET Framework writes each header character as one
  # byte, so anything wider would reach the server changed.
  if ($token -cnotmatch '^[!-~]+\z') { Stop-Dtc 4 'DAINTREE_MCP_TOKEN is malformed' }
  if ($url -ceq '') {
    Stop-Dtc 4 "DAINTREE_MCP_URL is not set. Outside an agent pane, set it to the URL in Settings > MCP server as well as DAINTREE_MCP_TOKEN: on Windows the running Daintree's port isn't found by itself."
  }
  $port = 0
  if ($url -cmatch '^http://(127\.0\.0\.1|localhost):([0-9]{1,5})(/mcp|/sse)?/?\z') { $port = [int]$Matches[2] }
  if ($port -lt 1 -or $port -gt 65535) {
    Stop-Dtc 4 "DAINTREE_MCP_URL must be Daintree's local endpoint, like http://127.0.0.1:45454/mcp"
  }
  $script:Endpoint = 'http://127.0.0.1:' + $port + '/mcp'
  $script:Token = $token
  $script:Session = ''
  $script:Version = ''
  $script:Close = $false
  Initialize-DtcHttp
}

# Opens a session: initialize, then notifications/initialized. Whatever opens
# is closed again on exit unless it is handed over.
function Open-DtcSession {
  $script:Close = $true
  $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"daintree-cli","version":"1.0.0"}}}'
  $reply = Invoke-DtcRequest $init 10000 $true
  Assert-DtcAuthorized $reply
  if ($reply.Error -cne '') { Stop-Dtc 3 ('could not reach Daintree at ' + $script:Endpoint + ': ' + $reply.Error) }
  if ($reply.Status -ne 200) {
    # A refused handshake says why in a JSON-RPC error; nothing ran.
    $refusal = Get-DtcRefusal $reply.Body
    if ($null -ne $refusal) { Stop-Dtc 1 ('Daintree refused the session: ' + $refusal) }
    Stop-Dtc 3 ('Daintree refused the session (HTTP ' + $reply.Status + '): ' + (Get-DtcExcerpt $reply.Body))
  }
  $found = Find-DtcResponse $reply.Body '1'
  if ($null -eq $found) { Stop-Dtc 3 "Daintree's reply to initialize wasn't understood" }
  if (Test-DtcType (Get-DtcMember $found.Root 'error') 'object') {
    Stop-Dtc 1 ('Daintree refused the session: ' + (Get-DtcRpcError $found))
  }
  $negotiated = Get-DtcMember (Get-DtcMember $found.Root 'result') 'protocolVersion'
  $version = ''
  # As sent, escapes and all: an escaped version is refused, not decoded.
  if (Test-DtcType $negotiated 'string') { $version = $found.Text.Substring($negotiated.S + 1, $negotiated.E - $negotiated.S - 2) }
  if ($version -cnotmatch '^[0-9A-Za-z.-]+\z') { Stop-Dtc 3 "Daintree's reply to initialize wasn't understood" }
  if ($script:Session -ceq '') { Stop-Dtc 3 'Daintree opened no session' }
  $script:Version = $version

  $reply = Invoke-DtcRequest '{"jsonrpc":"2.0","method":"notifications/initialized"}' 10000 $false
  Assert-DtcAuthorized $reply
  if ($reply.Error -cne '') { Stop-Dtc 3 ('lost Daintree while opening the session: ' + $reply.Error) }
  if ($reply.Status -ne 200 -and $reply.Status -ne 202 -and $reply.Status -ne 204) {
    Stop-Dtc 3 ('Daintree refused the session (HTTP ' + $reply.Status + '): ' + (Get-DtcExcerpt $reply.Body))
  }
}

# Every text block of the result, in order, to stdout or with `toErr` to
# stderr; the count written.
function Write-DtcTexts($found, $result, [bool]$toErr) {
  $shown = 0
  $content = Get-DtcMember $result 'content'
  if (-not (Test-DtcType $content 'array')) { return 0 }
  foreach ($item in $content.A) {
    $type = Get-DtcMember $item 'type'
    $text = Get-DtcMember $item 'text'
    $kind = ''
    if (Test-DtcType $type 'string') { $kind = Get-DtcStringValue $found.Text $type }
    if ($kind -ceq 'text' -and (Test-DtcType $text 'string')) {
      Write-DtcText ((Get-DtcStringValue $found.Text $text) + "`n") $toErr
      $shown++
    } elseif (-not $toErr -and (Test-DtcType $type 'string')) {
      Write-DtcError ('daintree call: ' + $kind + " content not shown; use --json to see it`n")
    }
  }
  return $shown
}

function Invoke-DtcCall($argv) {
  $tool = ''
  $argsJson = ''
  $argsGiven = $false
  $argsStdin = $false
  $pairs = New-Object System.Collections.Generic.List[string]
  $keys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  $asJson = $false
  $script:Command = 'call'

  $i = 0
  while ($i -lt $argv.Count) {
    $a = $argv[$i]
    if ($a -ceq '-h' -or $a -ceq '--help') {
      Write-DtcText (Get-DtcCallUsage) $false
      Exit-Dtc 0
    } elseif ($a -ceq '--json') {
      $asJson = $true
    } elseif ($a -ceq '--arg' -or $a.StartsWith('--arg=', [StringComparison]::Ordinal)) {
      if ($a -ceq '--arg') {
        if ($i + 1 -ge $argv.Count) { Stop-Dtc 2 '--arg needs key=value' }
        $i++
        $pair = $argv[$i]
      } else {
        $pair = $a.Substring(6)
      }
      $eq = $pair.IndexOf([char]'=')
      if ($eq -lt 0) { Stop-Dtc 2 ("--arg needs key=value, got '" + $pair + "'") }
      $key = $pair.Substring(0, $eq)
      $value = $pair.Substring($eq + 1)
      if ($key -cnotmatch '^[A-Za-z0-9_.-]+\z') {
        Stop-Dtc 2 ("--arg key '" + $key + "' must be letters, digits, '_', '.' or '-' (use --args for anything else)")
      }
      if (-not $keys.Add($key)) { Stop-Dtc 2 ('--arg ' + $key + ' is given twice') }
      $pairs.Add((ConvertTo-DtcJsonString $key) + ':' + (ConvertTo-DtcJsonString $value))
    } elseif ($a -ceq '--args' -or $a.StartsWith('--args=', [StringComparison]::Ordinal)) {
      if ($argsGiven) { Stop-Dtc 2 '--args is given twice' }
      $argsGiven = $true
      if ($a -ceq '--args') {
        if ($i + 1 -ge $argv.Count) { Stop-Dtc 2 '--args needs a JSON object' }
        $i++
        $argsJson = $argv[$i]
      } else {
        $argsJson = $a.Substring(7)
      }
      if ($argsJson -ceq '-') { $argsStdin = $true }
      if ($argsJson -ceq '') { Stop-Dtc 2 '--args needs a JSON object' }
    } elseif ($a.StartsWith('-', [StringComparison]::Ordinal)) {
      Stop-Dtc 2 ("unknown option '" + $a + "' (see daintree call --help)")
    } else {
      if ($tool -cne '') { Stop-Dtc 2 ("expected one tool name, got '" + $tool + "' and '" + $a + "'") }
      $tool = $a
    }
    $i++
  }

  if ($tool -ceq '') { Stop-Dtc 2 'missing the tool to call (see daintree call --help)' }
  if ($argsGiven -and $pairs.Count -gt 0) { Stop-Dtc 2 'use --arg or --args, not both' }
  if ($argsStdin) {
    # Read in the background and waited on in steps, so Ctrl+C still works
    # while a writer holds the pipe open.
    $buffer = New-Object System.IO.MemoryStream
    $copy = [Console]::OpenStandardInput().CopyToAsync($buffer)
    [void](Wait-DtcTask $copy 0)
    if ($copy.IsFaulted -or $copy.IsCanceled) { Stop-Dtc 2 "--args - couldn't read stdin" }
    $bytes = $buffer.ToArray()
    $skip = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $skip = 3 }
    try {
      $argsJson = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes, $skip, $bytes.Length - $skip)
    } catch {
      Stop-Dtc 2 "--args - read text that isn't UTF-8"
    }
    $argsJson = $argsJson.TrimEnd([char]10)
    if ($argsJson -ceq '') { Stop-Dtc 2 '--args - read no JSON object from stdin' }
  }

  $arguments = '{' + [string]::Join(',', $pairs.ToArray()) + '}'
  if ($argsGiven) {
    $parsed = Read-DtcJson $argsJson
    if ($null -eq $parsed) {
      $problem = $script:JsonError
      if ($problem.Length -gt 200) { $problem = $problem.Substring(0, 200) }
      Stop-Dtc 2 ('--args must be one JSON object: ' + $problem)
    }
    if ($parsed.T -cne 'object') { Stop-Dtc 2 '--args must be one JSON object: not a JSON object' }
    $arguments = $argsJson
  }
  Send-DtcCall $tool $asJson $arguments
}

function Send-DtcCall([string]$tool, [bool]$asJson, [string]$arguments) {
  $handle = [string]$env:DAINTREE_MCP_SESSION
  $id = '2'
  $held = $null
  if ($handle -cne '') { $held = Read-DtcHandle $handle }

  Initialize-Dtc
  if ($null -eq $held) {
    Open-DtcSession
  } else {
    $script:Session = $held.Session
    $script:Version = $held.Version
    $id = New-DtcRequestId
  }

  $body = '{"jsonrpc":"2.0","id":' + $id + ',"method":"tools/call","params":{"name":' + (ConvertTo-DtcJsonString $tool) + ',"arguments":' + $arguments + '}}'
  $reply = Invoke-DtcRequest $body 0 $false
  Assert-DtcAuthorized $reply
  if ($null -ne $held) { Assert-DtcSessionLive $reply }
  if ($reply.Error -cne '') {
    Stop-Dtc 3 ('the call to ' + $tool + ' was sent, but its answer was lost (' + $reply.Error + '); it may have run')
  }
  if ($reply.Status -ne 200) {
    # Refused before it ran (a body over the size limit): a JSON-RPC error says why.
    $refusal = Get-DtcRefusal $reply.Body
    if ($null -ne $refusal) { Stop-Dtc 1 ('Daintree refused the call to ' + $tool + ': ' + $refusal) }
    Stop-Dtc 3 ("Daintree didn't answer the call to " + $tool + ' (HTTP ' + $reply.Status + '): ' + (Get-DtcExcerpt $reply.Body))
  }

  $found = Find-DtcResponse $reply.Body $id
  if ($null -eq $found) {
    Stop-Dtc 3 ('the call to ' + $tool + " was sent, but no answer to it was found in Daintree's reply; it may have run")
  }
  if (Test-DtcType (Get-DtcMember $found.Root 'error') 'object') {
    Write-DtcError ((Get-DtcRpcError $found) + "`n")
    Exit-Dtc 1
  }
  $result = Get-DtcMember $found.Root 'result'
  $failed = Test-DtcType (Get-DtcMember $result 'isError') 'true'
  try {
    if ($asJson) {
      Write-DtcText ((Get-DtcRaw $found.Text $result) + "`n") $false
      if ($failed) { [void](Write-DtcTexts $found $result $true) }
    } elseif ((Write-DtcTexts $found $result $failed) -eq 0) {
      Write-DtcText ((Get-DtcRaw $found.Text $result) + "`n") $failed
    }
  } catch {
    Stop-Dtc 3 ('the answer from ' + $tool + " couldn't be written: " + $_.Exception.Message)
  }
  if ($failed) { Exit-Dtc 1 }
  Exit-Dtc 0
}

function Invoke-DtcSession($argv) {
  $script:Command = 'session'
  $first = ''
  if ($argv.Count -gt 0) { $first = $argv[0] }
  if ($first -ceq '-h' -or $first -ceq '--help') {
    Write-DtcText (Get-DtcSessionUsage) $false
    Exit-Dtc 0
  }
  if ($first -cne 'start' -and $first -cne 'end') { Stop-Dtc 2 'expected start or end (see daintree session --help)' }
  if ($argv.Count -ne 1) { Stop-Dtc 2 ("expected start or end alone, got '" + [string]::Join(' ', $argv.ToArray()) + "'") }
  if ($first -ceq 'start') { Start-DtcSession } else { Stop-DtcSession }
}

function Start-DtcSession {
  if ([string]$env:DAINTREE_MCP_SESSION -cne '') {
    Stop-Dtc 2 'DAINTREE_MCP_SESSION already names a session: end it first, or clear it to open a second one'
  }
  Initialize-Dtc
  Open-DtcSession
  # Handed over only once the handle is out: a write that fails closes the
  # session no one was told about. .NET reports a write to a pipe whose reader
  # has gone as written, though, so that case isn't caught here as bash does.
  try {
    Write-DtcText ($script:Version + ':' + $script:Session + "`n") $false
  } catch {
    Stop-Dtc 3 "could not print the session's handle; closing the session again"
  }
  $script:Close = $false
  Exit-Dtc 0
}

function Stop-DtcSession {
  $handle = [string]$env:DAINTREE_MCP_SESSION
  if ($handle -ceq '') { Stop-Dtc 2 'DAINTREE_MCP_SESSION is not set, so there is no session to end' }
  $held = Read-DtcHandle $handle
  Initialize-Dtc
  $script:Session = $held.Session
  $script:Version = $held.Version
  $reply = Invoke-DtcRequest '' 10000 $false
  Assert-DtcAuthorized $reply
  Assert-DtcSessionLive $reply
  # The status alone settles it: the server closes the session before it
  # answers, so a reply cut short after a 2xx still ended it.
  if ($reply.Status -eq 200 -or $reply.Status -eq 202 -or $reply.Status -eq 204) { Exit-Dtc 0 }
  if ($reply.Error -cne '') {
    Stop-Dtc 3 ('could not reach Daintree at ' + $script:Endpoint + ' to end the session: ' + $reply.Error)
  }
  Stop-Dtc 3 ("Daintree didn't end the session (HTTP " + $reply.Status + '): ' + (Get-DtcExcerpt $reply.Body))
}

try {
  try {
    $argv = Split-DtcCommandLine ([string]$env:DAINTREE_CLI_ARGS)
    $rest = New-Object System.Collections.Generic.List[string]
    for ($k = 1; $k -lt $argv.Count; $k++) { $rest.Add($argv[$k]) }
    if ($argv.Count -gt 0 -and $argv[0] -ceq 'call') {
      Invoke-DtcCall $rest
    } elseif ($argv.Count -gt 0 -and $argv[0] -ceq 'session') {
      Invoke-DtcSession $rest
    } else {
      $script:Command = 'call'
      Stop-Dtc 2 'expected call or session'
    }
  } catch {
    Stop-Dtc 3 ('stopped unexpectedly: ' + $_.Exception.Message)
  }
} finally {
  Close-Dtc
  # Reached without an exit of its own only when Ctrl+C stopped the script.
  if (-not $script:Exiting) { [Environment]::Exit(170) }
}
