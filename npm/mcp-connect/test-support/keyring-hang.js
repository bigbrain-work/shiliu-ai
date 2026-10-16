// Synthetic worker only: never imports or accesses the OS credential store.
if (process.env.SHILIU_KEYRING_HANG_FIXTURE === "1") {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write('{"value":"synthetic-incomplete-secret');
    process.stderr.write("synthetic-secret token invalid 401");
    setInterval(() => {}, 1000);
  });
}
