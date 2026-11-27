import crypto from 'node:crypto';
import stableStringify from 'json-stable-stringify';
import { describe, expect, it } from 'vitest';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
import { OutputVerificationError, isOutputVerificationFailure, PRIVATE_OUTPUT_PROTOCOL } from '../src/compute/privateOutputTransport.js';

const jobId = '3ef91af5-5335-4595-8e8a-0618d2c1c039';
const nothing = {} as never;
const runtime = new RemoteComputeRuntime({
  api: nothing, kubo: nothing, store: nothing, captures: nothing, jobs: nothing, gate: nothing, identity: nothing, transport: nothing, logger: nothing,
  config: { localDataPath: '/tmp/kubus-signed-output' } as never,
});

function jobWith(signingKey: string, signature: string, privateOutput: unknown = {}) {
  const payload = { jobId, inputHash: 'a'.repeat(64), jobSpecHash: 'b'.repeat(64), protocolVersion: 'kubus.compute/1', outputCids: ['bafymanifest'], privateOutput };
  return {
    id: jobId, inputHash: 'a'.repeat(64), jobSpecHash: 'b'.repeat(64), protocolVersion: 'kubus.compute/1', outputManifestCid: 'bafymanifest', outputCids: ['bafymanifest'],
    canonicalJobSpec: { processing: { outputMode: PRIVATE_OUTPUT_PROTOCOL } },
    providerReceipt: { payload, signature }, verification: { providerSigningPublicKey: signingKey },
  } as never;
}

describe('the signed commitment of a provider result', () => {
  it('a provider signing key that is not valid DER is a verification failure, not an unclassified OpenSSL error', async () => {
    const failure = await runtime.stagePrivateOutput(jobWith(Buffer.from('not a key').toString('base64'), 'AAAA')).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(OutputVerificationError);
    expect(isOutputVerificationFailure(failure)).toBe(true);
  });

  it('a valid key that does not match the signature, and an invalid commitment under a good signature, stay verification failures with their codes', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const wrong = await runtime.stagePrivateOutput(jobWith(publicKey, 'AAAA')).then(() => null, (error: unknown) => error);
    expect(wrong).toMatchObject({ code: 'private_output_signature_invalid', statusCode: 422 });
    expect(isOutputVerificationFailure(wrong)).toBe(true);
    const base = jobWith(publicKey, '') as { providerReceipt: { payload: Record<string, unknown>; signature: string } };
    base.providerReceipt.signature = crypto.sign(null, Buffer.from(stableStringify(base.providerReceipt.payload) ?? ''), keys.privateKey).toString('base64');
    const invalid = await runtime.stagePrivateOutput(base as never).then(() => null, (error: unknown) => error);
    expect(invalid).toBeInstanceOf(OutputVerificationError);
    expect(invalid).toMatchObject({ message: 'private_output_commitment_invalid' });
  });
});
