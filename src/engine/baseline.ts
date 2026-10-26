import { appointmentApplicants, appointmentDate } from '../domain/appointment';
import { sameApplicants } from '../domain/applicants';
import type { EngineState } from './workflow';

// Called only with a fresh trusted dashboard reading after live tab,
// configuration and cancellation checks. A changed date is recoverable;
// changed identity/roster and uncertain mutations never authorize rebinding.
export function adoptAppointmentBaseline(state: EngineState, reading: unknown, now: string): EngineState {
  if (state.status !== 'running' || state.mode !== 'booking' || state.group?.kind !== 'paid' ||
      state.intent || state.executor?.actionPending || state.authentication?.pending)
    throw new Error('Appointment baseline cannot be updated.');
  if (!state.group.applicantIds || !sameApplicants(appointmentApplicants(reading), state.group.applicantIds))
    throw new Error('Applicant roster changed.');
  const currentDate = appointmentDate(reading, state.group);
  if (currentDate === state.group.currentDate) return state;
  return { ...state, group: { ...state.group, currentDate },
    lastCandidate: null, stage: null,
    executor: state.executor ? { ...state.executor, targetTime: null, skippedDates: [], loadingSince: undefined } : null,
    failureContext: null, authenticationFailureReason: null, nextPollAt: now, updatedAt: now };
}
