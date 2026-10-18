import { stdin, stdout } from "node:process";
import { runRetrievalWorker, requestRetrievalRefresh, stopRetrievalWorkers } from "../retrieval/worker.js";
import { retrievalEnabled } from "../retrieval/paths.js";
import { closeRetrievalReaders, RetrievalUnavailableError } from "../retrieval/index.js";
import { createInterface } from "node:readline";
import { measureRetrieval, measured } from "../retrieval/metrics.js";

import { DESKTOP_PROTOCOL_VERSION, type DesktopFailure } from "./contracts.js";
import { recordUnexpectedDesktopError } from "./diagnostics.js";
import { DesktopServiceError, ReviewStartCancelledError, desktopSuccess, handleDesktopRequest, runDesktopMemoryReview } from "./service.js";
import { CheckoutRepairRequiredError } from "../cloud/checkout-path.js";
import { LinkReviewRequiredError } from "../cloud/project-link-review.js";

const MAX_REQUEST_BYTES = 256 * 1024;

async function main(): Promise<void> {
  try {
    const input = await readBoundedInput();
    const request=JSON.parse(input) as {root?:string;action?:string};
    const result = await handleDesktopRequest(request);
    if(retrievalEnabled() && request.root && /^(memory\.review\.|memory\.ai\.(apply|revert)|memory\.working\.(keep|candidate)|memory\.promote-project|memory\.topic\.(save|membership)|project\.summary\.)/.test(request.action ?? "")) await requestRetrievalRefresh(request.root,true);
    stdout.write(`${JSON.stringify(desktopSuccess(result))}\n`);
  } catch (error) {
    const diagnosticId = error instanceof DesktopServiceError || error instanceof SyntaxError || error instanceof CheckoutRepairRequiredError || error instanceof LinkReviewRequiredError
      ? undefined : recordUnexpectedDesktopError(error, "desktop request");
    const failure: DesktopFailure = {
      version: DESKTOP_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: errorCode(error),
        message: safeMessage(error, diagnosticId)
      }
    };
    stdout.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}

async function readBoundedInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new DesktopServiceError("invalid-request", "Desktop request is too large.");
    chunks.push(buffer);
  }
  if (size === 0) throw new DesktopServiceError("invalid-request", "Desktop request is empty.");
  return Buffer.concat(chunks).toString("utf8");
}

function safeMessage(error: unknown, diagnosticId?: string): string {
  if (error instanceof CheckoutRepairRequiredError || error instanceof LinkReviewRequiredError) return error.message;
  if(error instanceof RetrievalUnavailableError) return error.message;
  if (error instanceof SyntaxError) return "Desktop request is not valid JSON.";
  if (error instanceof DesktopServiceError) return error.message;
  const message = error instanceof Error ? error.message : "Desktop operation failed.";
  if (/gate|active|busy|locked/i.test(message)) return "Another Code Butler operation is active. Try again shortly.";
  if ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM") {
    return "Code Butler does not have permission to access this folder or its project data.";
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") return "The disk is full; Code Butler could not initialize this project.";
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "The selected folder or project data is missing.";
  return diagnosticId
    ? `Code Butler could not complete the desktop operation. Diagnostic ${diagnosticId} was saved in the local desktop log.`
    : "Code Butler could not complete the desktop operation.";
}

function errorCode(error: unknown): DesktopFailure["error"]["code"] {
  if (error instanceof CheckoutRepairRequiredError || error instanceof LinkReviewRequiredError) return "invalid-request";
  if(error instanceof RetrievalUnavailableError) return "busy";
  if (error instanceof DesktopServiceError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /gate|active|busy|locked/i.test(message) ? "busy" : "internal";
}

async function streamReview(): Promise<void> {
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  let started = false;
  let stopping = false;
  for await (const line of lines) {
    if (!started) {
      started = true;
      if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
        stdout.write(`${JSON.stringify({ event: "error", message: "Desktop request is too large." })}\n`);
        break;
      }
      let request: unknown;
      try { request = JSON.parse(line); }
      catch {
        stdout.write(`${JSON.stringify({ event: "error", message: "Desktop request is not valid JSON." })}\n`);
        break;
      }
      void runDesktopMemoryReview(request,
        (progress) => stdout.write(`${JSON.stringify({ event: "progress", progress })}\n`),
        () => stopping,
        { onWaiting: (waiting) => stdout.write(`${JSON.stringify({ event: "waiting", waiting })}\n`) }
      ).then((run) => {
        stdout.write(`${JSON.stringify({ event: "done", run })}\n`);
      }).catch((error) => {
        if (error instanceof ReviewStartCancelledError) {
          stdout.write(`${JSON.stringify({ event: "cancelled" })}\n`);
          return;
        }
        const diagnosticId = error instanceof DesktopServiceError
          ? undefined : recordUnexpectedDesktopError(error, "AI review Start");
        stdout.write(`${JSON.stringify({ event: "error", message: safeMessage(error, diagnosticId) })}\n`);
        process.exitCode = 1;
      }).finally(() => { lines.close(); stdin.pause(); });
    } else if (line === "stop") {
      stopping = true;
      stdout.write(`${JSON.stringify({ event: "stopping" })}\n`);
    }
  }
}

async function serveRequests():Promise<void> {
  const profiling=process.env.CODE_BUTLER_BENCHMARK==="1";
  if(profiling) stdout.write(JSON.stringify({benchmark:"ready"})+"\n");
  try { for await(const line of boundedRequestLines()) {
    let id:unknown;
    try {
      const envelope=JSON.parse(line) as {id:string;request:unknown}; id=envelope.id;
      if(typeof id!=="string" || id.length>128) throw new SyntaxError("Invalid request id");
      let response:string;
      if(profiling) {
        const timed=await measureRetrieval(async()=>{
          const result=await handleDesktopRequest(envelope.request);
          return measured("serialization",()=>JSON.stringify({id,...desktopSuccess(result)}));
        });
        response=JSON.stringify({...JSON.parse(timed.value),metrics:timed.metrics});
      } else {
        const result=await handleDesktopRequest(envelope.request);
        response=JSON.stringify({id,...desktopSuccess(result)});
      }
      if(Buffer.byteLength(response)>8*1024*1024) throw new DesktopServiceError("invalid-request","Desktop response is too large.");
      stdout.write(`${response}\n`);
    } catch(error) { stdout.write(`${JSON.stringify({id,version:1,ok:false,error:{code:errorCode(error),message:safeMessage(error)}})}\n`); }
  } } finally { await stopRetrievalWorkers();closeRetrievalReaders(); }
}
async function* boundedRequestLines():AsyncGenerator<string> {
  let pending=Buffer.alloc(0);
  for await(const raw of stdin) {
    let chunk=Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    while(chunk.length) {
      const end=chunk.indexOf(10);
      const piece=end<0 ? chunk : chunk.subarray(0,end);
      if(pending.length+piece.length>MAX_REQUEST_BYTES) throw new DesktopServiceError("invalid-request","Desktop request is too large.");
      pending=Buffer.concat([pending,piece]);
      if(end<0) break;
      yield pending.toString("utf8");pending=Buffer.alloc(0);chunk=chunk.subarray(end+1);
    }
  }
  if(pending.length) throw new SyntaxError("Incomplete desktop request");
}
void (process.argv.includes("--retrieval-worker") ? runRetrievalWorker() : process.argv.includes("--serve") ? serveRequests() : process.argv.includes("--review") ? streamReview() : main());
