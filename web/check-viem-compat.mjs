/**
 * Fails the build if viem and @lifi/widget have drifted back apart.
 *
 * `useRoutes` in @lifi/widget 3.x calls `parseUnits(toAmount, decimals)` unconditionally while
 * building every route request -- including when only the "send" side of the form is filled in,
 * where `toAmount` is an empty string. viem returned `0n` for that input up to and including
 * 2.55.2, and throws `InvalidDecimalNumberError` from 2.55.4 onward.
 *
 * The failure is nastier than its cause: every route query throws *before reaching the network*,
 * so the widget reports "No routes available" while LI.FI's API, asked the same question
 * directly, answers with perfectly good routes. Neither a typecheck nor a build notices, because
 * the versions are compatible on paper -- the widget asks for `^2.47.2` and gets it. So this
 * check exercises the actual call rather than trusting the version range.
 *
 * If it fails, do not paper over it in the widget config by seeding `toAmount`: the form clears
 * that field again on the next interaction, and the bug comes back looking new. Either hold viem
 * at a working version or move to @lifi/widget v4, which fixed the call and requires React 19.
 */
import { parseUnits } from "viem";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const viemVersion = require("viem/package.json").version;
const widgetVersion = require("@lifi/widget/package.json").version;

let result;
try {
  result = parseUnits("", 18);
} catch (error) {
  console.error(
    `\n  viem ${viemVersion} is incompatible with @lifi/widget ${widgetVersion}.\n\n` +
      `  parseUnits("", 18) threw ${error.name ?? "an error"} where the widget expects 0n.\n` +
      `  The bridge will report "No routes available" for every quote.\n\n` +
      `  Last known-good viem: 2.55.2. See web/README.md, "Bridge".\n`,
  );
  process.exit(1);
}

if (result !== 0n) {
  console.error(
    `\n  parseUnits("", 18) returned ${result}, expected 0n (viem ${viemVersion}).\n` +
      `  See web/README.md, "Bridge".\n`,
  );
  process.exit(1);
}

console.log(`viem ${viemVersion} is compatible with @lifi/widget ${widgetVersion}`);
