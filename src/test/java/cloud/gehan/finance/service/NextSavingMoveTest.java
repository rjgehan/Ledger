package cloud.gehan.finance.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.TreeMap;

import org.junit.jupiter.api.Test;

/** Home's "next transfer": the same day of the month in at least two recent months. */
class NextSavingMoveTest {

    @Test
    void twiceAMonthTransfersPredictTheNextOne() {
        TreeMap<LocalDate, Long> moves = new TreeMap<>();
        moves.put(LocalDate.of(2026, 9, 5), 37500L);
        moves.put(LocalDate.of(2026, 9, 21), 37500L); // the 20th fell on a Sunday
        moves.put(LocalDate.of(2026, 10, 5), 37500L);
        moves.put(LocalDate.of(2026, 10, 20), 37500L);
        moves.put(LocalDate.of(2026, 11, 5), 37500L);

        SummaryService.Move next = SummaryService.nextMove(moves, LocalDate.of(2026, 11, 17));
        assertThat(next.day()).isEqualTo(LocalDate.of(2026, 11, 20));
        assertThat(next.cents()).isEqualTo(37500L);

        // The 20th's move already made: the next one is December's 5th.
        moves.put(LocalDate.of(2026, 11, 20), 37500L);
        assertThat(SummaryService.nextMove(moves, LocalDate.of(2026, 11, 21)).day()).isEqualTo(LocalDate.of(2026, 12, 5));
    }

    @Test
    void aSingleMoveIsntAPattern() {
        TreeMap<LocalDate, Long> moves = new TreeMap<>();
        moves.put(LocalDate.of(2026, 11, 2), 50000L);
        assertThat(SummaryService.nextMove(moves, LocalDate.of(2026, 11, 17))).isNull();
    }
}
