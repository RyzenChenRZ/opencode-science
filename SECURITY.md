# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: go to the repository's **Security** tab and
choose **Report a vulnerability**. If that is not available to you, open a
regular issue that says only "security report available on request" with no
details, and a maintainer will arrange a private channel.

Please include, as far as you can:

- what the problem is, and what an attacker gains from it
- the version or commit you tested
- the steps to reproduce it
- anything you have already tried

You will get an acknowledgement within a week. Please give the maintainers
reasonable time to publish a fix before disclosing publicly.

## What this plugin does and does not do

The plugin runs inside OpenCode with the user's own permissions. It has no
server of its own, no daemon, and no account of its own. That shapes what a
vulnerability can look like here.

**It makes outbound HTTP requests.** To the bibliographic and biological
databases it names, and to wherever an open-access copy of a paper is
published. Every request goes through an admission check: the scheme must be
HTTP or HTTPS, and the host must not be a loopback, link-local, or private
address. Redirects are followed by hand and every hop is re-checked, because
the host that answers the first request chooses where to go next.

**It reads and writes files in the user's workspace.** It writes the
literature library, the screening record, downloaded documents, run logs, the
artifact ledger, and reviews, all under `.opencode-science/`. A path that
would escape the workspace is refused.

**It runs the user's own Python or R.** With the user's own interpreter, in
the user's own directory, for code the user or their agent wrote. The plugin
records what ran; it does not decide what is safe to run.

**It never writes to a remote service.** Every connector is read-only.

**It reads credentials from the environment or from OpenCode's configuration,
and stores them nowhere.** No secret is written into this repository, into the
workspace, or into any file the plugin creates.

## What a report is likely to be about

- A host that can reach an internal address the admission check does not
  catch.
- A path that escapes the workspace.
- A credential written somewhere it should not be.
- A document attached to a record it does not belong to, which would make a
  later judgement about the wrong paper.
