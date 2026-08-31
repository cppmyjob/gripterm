// The native half of the acceptance double: a `claude.exe` that is really
// `node fake-claude.mjs`.
//
// WHY THERE HAS TO BE ONE, measured 2026-08-31 on this machine rather than
// assumed. The obvious double is a `claude.cmd` shim, and it fails in the one
// place nobody would look:
//
//   * a pty CAN start it -- node-pty 1.1.0 starts `claude.cmd` and its arguments
//     arrive, though `cmd.exe` is interposed and eats `&`, `|` and `^` inside a
//     value;
//   * but `execFile` CANNOT. Node 22.16 answers `spawn EINVAL` for a `.bat` or a
//     `.cmd` without `shell: true` (the mitigation of CVE-2024-27980), and
//     `runCli` in this build is `execFile` with no shell, on purpose and for
//     stated reasons. So `claude agents --json` and `claude --version` would both
//     fail against a shim -- and the first of those is what the restore path asks
//     before it brings a conversation back. The suites would then be measuring a
//     window that could not see what was running, and reporting it as П2.
//
// So the file on the PATH has to be a real executable, and this is the smallest
// one that does the job: it starts `node` on the script beside it, hands over
// the console it was given, and leaves with the exit code it gets back. Nothing
// else. Every behaviour of the double is in `fake-claude.mjs`, which is a file a
// person can read.
//
// It is compiled by `tests/acceptance/fake-claude/build.mjs` with the C# compiler
// that ships with the .NET Framework, into `.test-output/`, which is not tracked
// and never packaged.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

static class ClaudeLauncher
{
    static int Main()
    {
        string here = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string script = Path.Combine(here, "fake-claude.mjs");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("fake-claude: no fake-claude.mjs beside " + here);
            return 66;
        }

        // The interpreter by absolute path when the run named one, which is what
        // `tests/acceptance/run.mjs` does. The bare name is the fallback for a
        // person running this by hand, and it is a fallback rather than the rule
        // for the reason C5-2 states: a bare `node` on somebody's PATH is not
        // guaranteed.
        string node = Environment.GetEnvironmentVariable("GRIPTERM_FAKE_CLAUDE_NODE");
        if (string.IsNullOrEmpty(node))
        {
            node = "node";
        }

        // `GetCommandLineArgs()[0]` is this executable; everything after it is
        // what the caller wrote, already parsed by Windows.
        string[] argv = Environment.GetCommandLineArgs();
        StringBuilder line = new StringBuilder();
        line.Append(Quote(script));
        for (int at = 1; at < argv.Length; at++)
        {
            line.Append(' ');
            line.Append(Quote(argv[at]));
        }

        ProcessStartInfo how = new ProcessStartInfo(node, line.ToString());
        // No shell and no redirection: the child inherits this program's console,
        // which is the pty the editor made, and that is the whole point -- a
        // redirected child would be a terminal nobody could type into.
        how.UseShellExecute = false;
        Process child = Process.Start(how);
        child.WaitForExit();
        return child.ExitCode;
    }

    // The quoting rule `CommandLineToArgvW` undoes, which is the one Windows
    // itself applies when the child parses its command line. It is written out
    // rather than left to a library because .NET Framework has no
    // `ArgumentList`; `build.mjs` makes the round trip a MEASUREMENT before any
    // suite is allowed to run, so a mistake here is caught by a nasty vector and
    // not by a puzzling acceptance failure.
    static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        for (int at = 0; ; at++)
        {
            int slashes = 0;
            while (at < argument.Length && argument[at] == '\\')
            {
                at++;
                slashes++;
            }
            if (at == argument.Length)
            {
                quoted.Append('\\', slashes * 2);
                break;
            }
            if (argument[at] == '"')
            {
                quoted.Append('\\', slashes * 2 + 1);
                quoted.Append('"');
            }
            else
            {
                quoted.Append('\\', slashes);
                quoted.Append(argument[at]);
            }
        }
        quoted.Append('"');
        return quoted.ToString();
    }
}
