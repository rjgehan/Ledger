package cloud.gehan.finance.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.List;

import org.junit.jupiter.api.Test;

import cloud.gehan.finance.model.Transaction;

/** Home's reason for a category's spending, when no single charge was most of it. */
class HomeWhyTest {

    @Test
    void thePlaceItWentMostIsTheReason() {
        SummaryService.Why w = SummaryService.why(1L, "Bars", 26252, 20000L, List.of(
                spend("SPARROW WINE & LIQUOR", -7887), spend("SPARROW WINE & LIQUOR", -5221),
                spend("BLACK BEAR BAR", -9317), spend("8TH STREET TAVERN", -3827)));
        assertThat(w.driver()).isEqualTo("place");
        assertThat(w.driverCents()).isEqualTo(13108);
        assertThat(w.visits()).isEqualTo(2);
        assertThat(w.count()).isEqualTo(4);
        assertThat(w.label().toUpperCase()).contains("SPARROW");
    }

    @Test
    void noRepeatPlaceLeavesJustTheCount() {
        SummaryService.Why w = SummaryService.why(1L, "Health", 6000, null, List.of(
                spend("CVS PHARMACY", -2000), spend("WALGREENS", -2500), spend("DUANE READE", -1500)));
        assertThat(w.driver()).isEqualTo("count");
        assertThat(w.count()).isEqualTo(3);
    }

    private static Transaction spend(String description, long cents) {
        return new Transaction(null, "test:" + description + cents, LocalDate.now(), cents, description);
    }
}
