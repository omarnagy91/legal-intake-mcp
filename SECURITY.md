# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue. Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include the version, the tool you called, and the smallest document or input that reproduces the problem.

You can expect an acknowledgement within a few days. Fixes are released as a patch version and credited if you want to be named.

## Scope

What this server does, so you know what counts:

- It reads local files (`.txt`, `.docx`, `.pdf`) whose paths the client passes to its tools, and returns extracted text, clauses, dates and parties with anchors.
- It makes **no network call**, holds **no credentials**, reads **no environment variables**, and starts no child process. It speaks MCP over stdio only.
- It caches parsed documents in memory for the life of the process. Nothing is written to disk.

In scope:

- Crashes, hangs or runaway memory use triggered by a crafted document (zip bombs in `.docx`, hostile PDFs, pathological regex input).
- Reading a file the caller did not name (path handling bugs).
- Output that misattributes text to the wrong anchor in a way that could mislead a reviewer.

Out of scope:

- Legal correctness of any output. The server extracts and cites, it does not advise.
- Vulnerabilities in the MCP client you connect it to, or in Node.js itself.
- Access control: the server trusts whoever can launch it, because it runs as your user and reads the paths you give it. Do not expose it on a shared host as a service.

## Supported versions

Only the latest release receives fixes.
