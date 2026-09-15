import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { BrightspaceError } from './errors.js';
import { snapshotFile } from './submissions.js';

export interface PrintSettings { copies: number; colour: boolean; duplex: boolean; staple: boolean }
export interface PrintInspection {
  accountId: string;
  accountLabel: string;
  destination: string;
  settings: PrintSettings;
  cost: { amount: number | null; currency: 'EUR'; explanation: string };
}
type FileSnapshot = Awaited<ReturnType<typeof snapshotFile>>;
export interface PrintTransport {
  /** Inspect account and settings without uploading any document. */
  inspect(settings: PrintSettings): Promise<PrintInspection>;
  /** The transport must recheck the account before sending bytes and must never retry writes. */
  submit(preview: PrintInspection, file: FileSnapshot): Promise<{ queued: boolean; jobId: string }>;
}
interface Pending { inspection: PrintInspection; file: Omit<FileSnapshot, 'bytes'>; expiresAt: number }

export function validatePrintSettings(value: PrintSettings): PrintSettings {
  if (!value || !Number.isInteger(value.copies) || value.copies < 1 || value.copies > 100
    || ['colour', 'duplex', 'staple'].some(key => typeof value[key as keyof PrintSettings] !== 'boolean')) {
    throw new BrightspaceError('INVALID_PRINT_SETTINGS', 'Choose 1 to 100 copies and explicit colour, duplex and staple settings.');
  }
  return { copies: value.copies, colour: value.colour, duplex: value.duplex, staple: value.staple };
}

/** Approval is required before even uploading a document to the print provider. */
export class PrintActions {
  private pending = new Map<string, Pending>();
  private generation = 0;
  constructor(private readonly transport: PrintTransport, private readonly now = Date.now) {}

  async prepare(path: string, input: PrintSettings) {
    const generation = this.generation;
    const settings = validatePrintSettings(input), file = await snapshotFile(path);
    if (extname(file.filename).toLowerCase() !== '.pdf' || !file.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new BrightspaceError('INVALID_PRINT_FILE', 'Select a PDF document. This integration initially supports PDF files only.');
    }
    const inspection = structuredClone(await this.transport.inspect(settings));
    this.unchanged(generation);
    if (JSON.stringify(inspection.settings) !== JSON.stringify(settings)) {
      throw new BrightspaceError('INVALID_PRINT_SETTINGS', 'The provider could not preserve the selected settings.');
    }
    const { bytes: _, ...metadata } = file;
    for (const [token, item] of this.pending) if (item.expiresAt <= this.now()) this.pending.delete(token);
    if (this.pending.size >= 8) this.pending.delete(this.pending.keys().next().value!);
    const confirmationToken = randomBytes(24).toString('hex'), expiresAt = this.now() + 5 * 60_000;
    this.pending.set(confirmationToken, { inspection, file: metadata, expiresAt });
    return { ...structuredClone(inspection), file: metadata, confirmationToken,
      expiresAt: new Date(expiresAt).toISOString(), physicalReleaseRequired: true,
      action: 'Upload this document to the TU Delft print queue. Release it separately at a campus printer.' };
  }

  async confirm(token: string, confirmed: boolean) {
    const generation = this.generation;
    if (confirmed !== true) throw new BrightspaceError('CONFIRMATION_REQUIRED', 'Approve the exact print preview before uploading.');
    const pending = this.pending.get(token);
    this.pending.delete(token); // Consume synchronously, before any asynchronous account or file checks.
    if (!pending || pending.expiresAt <= this.now()) throw new BrightspaceError('INVALID_CONFIRMATION', 'The print preview expired or was already used. Prepare a new preview.');
    const file = await snapshotFile(pending.file.path);
    if (file.sha256 !== pending.file.sha256 || file.size !== pending.file.size || file.filename !== pending.file.filename) {
      throw new BrightspaceError('FILE_CHANGED', 'The print file changed. Prepare and approve a new preview.');
    }
    const current = await this.transport.inspect(pending.inspection.settings);
    this.unchanged(generation);
    if (JSON.stringify(current) !== JSON.stringify(pending.inspection)) {
      throw new BrightspaceError('PRINT_PREVIEW_CHANGED', 'The print account, settings or quote changed. Prepare and approve a new preview.');
    }
    try {
      const receipt = await this.transport.submit(pending.inspection, file);
      if (!receipt.queued || !receipt.jobId) throw new Error('No authoritative receipt');
      return { ...receipt, file: pending.file, settings: pending.inspection.settings, physicalReleaseRequired: true };
    } catch {
      throw new BrightspaceError('PRINT_OUTCOME_UNCERTAIN', 'The print request may have reached the provider. Check the print queue before preparing another submission. Do not retry automatically.');
    }
  }

  private unchanged(generation: number): void {
    if (generation !== this.generation) throw new BrightspaceError('PRINT_CANCELLED', 'The print connection was closed. Prepare a new preview.');
  }

  close(): void { this.generation++; this.pending.clear(); }
}
