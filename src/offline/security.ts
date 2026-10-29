import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from "node:crypto";
import { importJWK, jwtVerify, SignJWT, calculateJwkThumbprint, type JWK } from "jose";
import { OfflineError, canonical, validateGrant, type Grant } from "./contract.js";

export class OfflineAuthority {
  readonly publicJwk: JsonWebKey;
  readonly privateKey;
  private trustedKey;
  private constructor(readonly terminalId: string, readonly epoch: string,
    private issuer: string, privateKey: JsonWebKey, trustedPublicKey: JWK) {
    this.privateKey = createPrivateKey({ key: privateKey, format: "jwk" });
    if (this.privateKey.asymmetricKeyType !== "ed25519" || trustedPublicKey.kty !== "OKP" ||
        trustedPublicKey.crv !== "Ed25519" || "d" in trustedPublicKey) throw Error("Ed25519 keys required");
    this.publicJwk = createPublicKey(this.privateKey).export({ format: "jwk" });
    this.trustedKey = importJWK(trustedPublicKey, "EdDSA");
  }
  static async create(terminalId: string, epoch: string, issuer: string, privateKey: JsonWebKey, trustedPublicKey: JWK) {
    const authority = new OfflineAuthority(terminalId, epoch, issuer, privateKey, trustedPublicKey);
    await authority.trustedKey;
    return authority;
  }
  async enrollmentProof(nonce:string) {
    return new SignJWT({nonce,terminalId:this.terminalId,epoch:this.epoch})
      .setProtectedHeader({alg:"EdDSA",typ:"JWT"}).setIssuer(this.terminalId)
      .setAudience("smokehouse-offline-enrollment-v1").setIssuedAt().setExpirationTime("60s")
      .sign(this.privateKey);
  }
  async thumbprint() { return calculateJwkThumbprint(this.publicJwk as JWK); }
  async verifyGrant(token: string, now: number): Promise<Grant> {
    const { payload } = await jwtVerify(token, await this.trustedKey, {
      algorithms: ["EdDSA"], issuer: this.issuer, audience: "smokehouse-offline-pos-v1",
      currentDate: new Date(now), requiredClaims: ["exp", "iat"]
    });
    const grant = validateGrant(payload.grant, now);
    if (payload.exp! * 1000 !== grant.expiresAt || payload.iat! * 1000 !== grant.issuedAt ||
        grant.terminalId !== this.terminalId || grant.epoch !== this.epoch ||
        grant.terminalKey !== await this.thumbprint())
      throw new OfflineError("terminal_mismatch", "Authorization is not bound to this terminal.", 403);
    return grant;
  }
  sign(value: unknown): string { return sign(null, Buffer.from(canonical(value)), this.privateKey).toString("base64url"); }
  verify(value: unknown, signature: string): boolean {
    return verify(null, Buffer.from(canonical(value)), createPublicKey(this.privateKey), Buffer.from(signature,"base64url"));
  }
}
