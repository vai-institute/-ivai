# CVA Tool — Project Rules

## Versioning

This project uses Semantic Versioning (SemVer): X.Y.Z
- X (Major): breaking changes, incompatible with prior versions
- Y (Minor): new user-facing features or behavior changes, backward compatible
- Z (Patch): bug fixes only, no new features

At the end of every build session, before committing:
1. Review what changed this session
2. Ask Peter: "This looks like a [Major/Minor/Patch] bump — should I increment to X.Y.Z?"
3. Update package.json and the version display in the config popup
4. Include the version bump in the session commit
