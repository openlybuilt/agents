import { OnKernelProvider } from "./onkernel.js";

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Browser example interrupted"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const provider = new OnKernelProvider(process.env.ONKERNEL_API_KEY ?? "");
  const session = await provider.open({ signal: controller.signal });
  try {
    await session.navigate(process.argv[2] ?? "https://example.com");
    const screenshot = await session.screenshot();
    console.log(
      `Captured ${screenshot.bytes.byteLength} bytes (${screenshot.contentType})`,
    );
  } finally {
    await session.close();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
