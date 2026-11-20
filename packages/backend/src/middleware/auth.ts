import { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken, JwtPayload } from "../lib/auth";

declare module "fastify" {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "No token provided" });
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);
    // Allowlist: user endpoints accept only user access tokens (token confusion guard).
    // verifyAccessToken already enforces this; the check stays here so the
    // contract is visible where routes are protected.
    if (payload.type !== "user") {
      return reply.status(401).send({ error: "Invalid or expired token" });
    }
    request.user = payload;
  } catch {
    return reply.status(401).send({ error: "Invalid or expired token" });
  }
}
