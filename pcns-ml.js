/* PCNS supervised calibration model.
 * Fits distance = strideLengthM * detectedSteps using least squares through the origin.
 * This calibrates PDR step length; it is not a complete indoor localization model.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PCNSML = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const CALIBRATION_STATES = Object.freeze({
    IDLE: "IDLE",
    RECORDING: "RECORDING",
    INPUT_DISTANCE: "INPUT_DISTANCE",
  });

  function createCalibrationWizard() {
    let state = CALIBRATION_STATES.IDLE;
    let startStepCount = null;
    let recordedSteps = 0;

    function validateStepCount(stepCount) {
      if (!Number.isInteger(stepCount) || stepCount < 0) {
        throw new Error("The calibration wizard requires a non-negative integer step count.");
      }
    }

    return {
      get state() {
        return state;
      },
      get recordedSteps() {
        return recordedSteps;
      },
      start(stepCount) {
        validateStepCount(stepCount);
        if (state !== CALIBRATION_STATES.IDLE) {
          throw new Error("A calibration walk can only start from the idle state.");
        }
        startStepCount = stepCount;
        recordedSteps = 0;
        state = CALIBRATION_STATES.RECORDING;
      },
      stop(stepCount) {
        validateStepCount(stepCount);
        if (state !== CALIBRATION_STATES.RECORDING || startStepCount == null) {
          throw new Error("A calibration walk can only stop while recording.");
        }
        recordedSteps = Math.max(0, stepCount - startStepCount);
        startStepCount = null;
        state = CALIBRATION_STATES.INPUT_DISTANCE;
        return recordedSteps;
      },
      steps(currentStepCount) {
        validateStepCount(currentStepCount);
        return state === CALIBRATION_STATES.RECORDING && startStepCount != null
          ? Math.max(0, currentStepCount - startStepCount)
          : recordedSteps;
      },
      reset() {
        if (state !== CALIBRATION_STATES.INPUT_DISTANCE) {
          throw new Error("A calibration walk can only be reset after recording has stopped.");
        }
        startStepCount = null;
        recordedSteps = 0;
        state = CALIBRATION_STATES.IDLE;
      },
    };
  }

  function createCalibrationSample(steps, distanceM) {
    const cleanSteps = Number(steps);
    const cleanDistance = Number(distanceM);
    if (!Number.isInteger(cleanSteps) || cleanSteps < 1 || cleanSteps > 100000 ||
        !Number.isFinite(cleanDistance) || cleanDistance <= 0 || cleanDistance > 5000) {
      throw new Error("Enter a valid step count and a measured distance between 0 and 5,000 metres.");
    }
    const impliedStride = cleanDistance / cleanSteps;
    if (impliedStride < 0.15 || impliedStride > 2.5) {
      throw new Error("This sample implies an unusual step length. Recheck the step count and measured distance.");
    }
    return { steps: cleanSteps, distanceM: Number(cleanDistance.toFixed(3)) };
  }

  function fitStrideModel(samples) {
    if (!Array.isArray(samples) || samples.length < 2) {
      throw new Error("At least two measured walks are required to train the model.");
    }
    const clean = samples.map((sample, index) => {
      const steps = Number(sample.steps);
      const distanceM = Number(sample.distanceM ?? sample.distance);
      if (!Number.isInteger(steps) || steps < 1 || steps > 100000 ||
          !Number.isFinite(distanceM) || distanceM <= 0 || distanceM > 5000) {
        throw new Error(`Calibration sample ${index + 1} is invalid.`);
      }
      return { steps, distanceM };
    });

    let numerator = 0;
    let denominator = 0;
    for (const sample of clean) {
      numerator += sample.steps * sample.distanceM;
      denominator += sample.steps * sample.steps;
    }
    if (denominator <= 0) throw new Error("No usable step data was supplied.");

    const strideLengthM = numerator / denominator;
    if (!Number.isFinite(strideLengthM) || strideLengthM < 0.25 || strideLengthM > 1.8) {
      throw new Error(`The fitted stride (${strideLengthM.toFixed(3)} m) is outside the safe range 0.25–1.80 m. Check the measured distances and step counts.`);
    }

    const meanDistance = clean.reduce((sum, sample) => sum + sample.distanceM, 0) / clean.length;
    let squaredError = 0;
    let absoluteError = 0;
    let totalVariance = 0;
    for (const sample of clean) {
      const residual = sample.distanceM - strideLengthM * sample.steps;
      squaredError += residual * residual;
      absoluteError += Math.abs(residual);
      totalVariance += (sample.distanceM - meanDistance) ** 2;
    }
    const rmse = Math.sqrt(squaredError / clean.length);
    const mae = absoluteError / clean.length;
    const r2 = totalVariance > 0 ? 1 - squaredError / totalVariance : null;
    return {
      modelType: "supervised-linear-stride-regression-v1",
      strideLengthM,
      sampleCount: clean.length,
      rmseM: rmse,
      maeM: mae,
      r2,
      trainedAt: new Date().toISOString(),
    };
  }

  function predictDistance(model, steps) {
    if (!model || !Number.isFinite(model.strideLengthM) || !Number.isFinite(steps) || steps < 0) {
      throw new Error("A valid trained model and non-negative step count are required.");
    }
    return model.strideLengthM * steps;
  }

  return {
    CALIBRATION_STATES,
    createCalibrationWizard,
    createCalibrationSample,
    fitStrideModel,
    predictDistance,
  };
});
