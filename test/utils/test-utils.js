export const isCI = () => {
  let isCI = false
  try {
    if (window.PKC_PROTOCOL_TEST_CI) {
      isCI = true
    }
  } catch (e) {}
  try {
    if (process.env.CI) {
      isCI = true
    }
  } catch (e) {}
  return isCI
}
