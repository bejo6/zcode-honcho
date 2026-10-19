/** Small I/O helpers shared by the hook entrypoints. */

/** Read all of stdin as a UTF-8 string. Hooks receive one JSON document; an
 *  empty stdin (host chose not to send input) resolves to "". */
export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    // If stdin is a TTY or errors out, don't hang the hook.
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 2_000).unref();
  });
}

/** Best-effort JSON parse of hook input; anything malformed is just {}. */
export function parseHookInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
