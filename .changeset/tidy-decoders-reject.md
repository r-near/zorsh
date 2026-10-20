---
"@zorsh/zorsh": patch
---

Reject invalid bool/option tags, truncated strings, malformed UTF-8 and NaN floats; preserve leading U+FEFF in strings. Check byte payload bounds before allocating and grow decoded collections incrementally instead of preallocating from untrusted lengths.
