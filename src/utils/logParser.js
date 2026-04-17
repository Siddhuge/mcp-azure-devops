const parseLogs = (lines) => {
  const errors = [];
  const warnings = [];

  for (const line of lines) {
    const l = line.toLowerCase();

    if (
      l.includes("##[error]") ||
      l.includes("error") ||
      l.includes("failed") ||
      l.includes("exception")
    ) {
      errors.push(line);
    } else if (
      l.includes("##[warning]") ||
      l.includes("warning")
    ) {
      warnings.push(line);
    }
  }

  return {
    errors,
    warnings,
    summary: errors[0] || "No critical error found"
  };
};

module.exports = { parseLogs };