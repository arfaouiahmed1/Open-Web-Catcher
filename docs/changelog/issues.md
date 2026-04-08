# Known Cleanup Notes

The migration away from the old dashboard and external tracing stack is complete in product code.

## Remaining Non-Blocking Notes

- Some local virtual environments may still contain third-party tracing package names because they are transitive dependencies of installed libraries.
- Tool wrapper classes still emit Pydantic v2 deprecation warnings about class-based config.
- Historical references may still exist in private local files that are not part of the tracked documentation set.
