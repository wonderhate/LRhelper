import { expect, it } from "@jest/globals";
import { redactLog } from "../src/log-safety.js";

it("redacts credentials and paths from persisted diagnostics", () => {
  const secrets = [
    "my-long-token",
    "sk-private-credential",
    "my-key-value",
    "abc.def.bearer",
    "C:\\Users\\Private Person\\Reference Photo.jpg",
    "/home/private/Reference Photo.jpg",
    "\\\\private-server\\Share\\Reference Photo.jpg",
  ];
  const lines = [
    "parse failed token=" + secrets[0] + " apiKey: '" + secrets[2] + "'",
    "request failed " + secrets[1] + "\nBearer " + secrets[3],
    ...secrets.slice(4).map(filename => "Could not read: " + filename),
  ];
  const result = lines.map(redactLog).join(" ");
  for (const secret of secrets) expect(result).not.toContain(secret);
  expect(result).toContain("parse failed");
  expect(result).toContain("[path]");
});
