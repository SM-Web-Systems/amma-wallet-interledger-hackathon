import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMail = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock("../config", () => ({
  config: { SMTP_HOST: "h", SMTP_PORT: 587, SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "from@example.test" },
}));

import { sendEmail } from "./mailer";
import { setAppLogger } from "./app-log";

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  sendMail.mockReset();
  const record = (obj: Record<string, unknown>, msg: string) => lines.push(JSON.stringify({ ...obj, msg }));
  setAppLogger({ info: record, warn: record, error: record });
});

describe("mail logging (G-11)", () => {
  it("logs the message id of a sent mail and never the recipient", async () => {
    sendMail.mockResolvedValue({ messageId: "<abc123@mail.test>" });
    expect(await sendEmail("person@example.test", "Subject", "<p>hi</p>")).toBe(true);
    const output = lines.join("");
    expect(output).toContain("<abc123@mail.test>");
    expect(output).not.toContain("person@example.test");
  });

  it("logs a failure without the recipient or the provider's message text", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("Can't send mail to person@example.test"), { code: "EENVELOPE" }));
    expect(await sendEmail("person@example.test", "Subject", "<p>hi</p>")).toBe(false);
    const output = lines.join("");
    expect(output).toContain("EENVELOPE");
    expect(output).not.toContain("person@example.test");
  });
});
