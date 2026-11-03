import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/types";

export type StoredCredential = {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
};

function rpID(): string {
  return process.env.HEIMDALL_RP_ID ?? "localhost";
}

function origin(): string {
  return process.env.HEIMDALL_ORIGIN ?? "http://127.0.0.1:43123";
}

export async function createRegistrationOptions(input: {
  userId: string;
  email: string;
  existingCredentialIds: string[];
}) {
  return generateRegistrationOptions({
    rpName: "Heimdall",
    rpID: rpID(),
    userName: input.email,
    userID: new TextEncoder().encode(input.userId),
    attestationType: "none",
    excludeCredentials: input.existingCredentialIds.map((id) => ({
      id,
      transports: ["internal", "hybrid"] as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
}

export async function verifyRegistration(input: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}) {
  return verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpID(),
  });
}

export async function createAuthenticationOptions(input: {
  allowCredentialIds: string[];
}) {
  return generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials: input.allowCredentialIds.map((id) => ({ id })),
    userVerification: "preferred",
  });
}

export async function verifyAuthentication(input: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: StoredCredential;
}) {
  const publicKey = Buffer.from(input.credential.publicKey, "base64url");
  return verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpID(),
    credential: {
      id: input.credential.credentialId,
      publicKey,
      counter: input.credential.counter,
      transports: input.credential.transports,
    },
  });
}
