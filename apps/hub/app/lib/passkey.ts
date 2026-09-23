type JsonObject = Record<string, unknown>;

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = window.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function requiredBuffer(value: unknown): ArrayBuffer {
  if (typeof value !== "string") throw new Error("The passkey challenge is invalid");
  return decodeBase64Url(value);
}

function deserializeCredentialDescriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as JsonObject;
    if (typeof record.id !== "string") return [];
    return [{
      type: "public-key",
      id: decodeBase64Url(record.id),
      ...(Array.isArray(record.transports) ? { transports: record.transports as AuthenticatorTransport[] } : {})
    }];
  });
}

export function supportsPasskeys(): boolean {
  return typeof window !== "undefined"
    && typeof window.PublicKeyCredential !== "undefined"
    && typeof navigator.credentials?.create === "function"
    && typeof navigator.credentials?.get === "function";
}

export function deserializeCreationOptions(options: JsonObject): PublicKeyCredentialCreationOptions {
  const user = options.user && typeof options.user === "object" ? options.user as JsonObject : null;
  if (!user || typeof user.name !== "string" || typeof user.displayName !== "string") {
    throw new Error("The passkey registration challenge is invalid");
  }
  return {
    ...options,
    challenge: requiredBuffer(options.challenge),
    user: {
      ...user,
      id: requiredBuffer(user.id)
    },
    ...(deserializeCredentialDescriptors(options.excludeCredentials)
      ? { excludeCredentials: deserializeCredentialDescriptors(options.excludeCredentials) }
      : {})
  } as PublicKeyCredentialCreationOptions;
}

export function deserializeRequestOptions(options: JsonObject): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: requiredBuffer(options.challenge),
    ...(deserializeCredentialDescriptors(options.allowCredentials)
      ? { allowCredentials: deserializeCredentialDescriptors(options.allowCredentials) }
      : {})
  } as PublicKeyCredentialRequestOptions;
}

export function serializePublicKeyCredential(credential: Credential): JsonObject {
  if (!(credential instanceof PublicKeyCredential)) throw new Error("The authenticator returned an invalid credential");
  const response = credential.response;
  const common: JsonObject = {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults()
  };
  if ("attestationObject" in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    return {
      ...common,
      response: {
        clientDataJSON: encodeBase64Url(attestation.clientDataJSON),
        attestationObject: encodeBase64Url(attestation.attestationObject),
        ...(typeof attestation.getTransports === "function" ? { transports: attestation.getTransports() } : {})
      }
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...common,
    response: {
      clientDataJSON: encodeBase64Url(assertion.clientDataJSON),
      authenticatorData: encodeBase64Url(assertion.authenticatorData),
      signature: encodeBase64Url(assertion.signature),
      userHandle: assertion.userHandle ? encodeBase64Url(assertion.userHandle) : null
    }
  };
}
