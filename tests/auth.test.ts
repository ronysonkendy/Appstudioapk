import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../backend/src/services/password";

describe("password", () => {
  it("verifica la contraseña correcta y rechaza la incorrecta", async () => {
    const h = await hashPassword("mi-clave-segura");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("mi-clave-segura", h)).toBe(true);
    expect(await verifyPassword("otra-clave", h)).toBe(false);
  });
  it("genera hashes distintos para la misma contraseña (sal aleatoria)", async () => {
    expect(await hashPassword("igual-igual")).not.toBe(await hashPassword("igual-igual"));
  });
  it("rechaza formatos inválidos", async () => {
    expect(await verifyPassword("x", "texto-sin-formato")).toBe(false);
  });
});
