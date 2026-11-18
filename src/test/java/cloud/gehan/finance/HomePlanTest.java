package cloud.gehan.finance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.LocalDate;
import java.time.YearMonth;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import cloud.gehan.finance.service.assistant.AssistantTools;

/**
 * One person whose pay lands in a savings account, and who pays rent, the loan and the
 * cards from there: Home's saving line, Claude's view of their pay, and their own name
 * for the loan.
 */
@SpringBootTest(properties = "spring.datasource.url=jdbc:sqlite:target/test-data/home-plan-test.db?busy_timeout=10000")
@AutoConfigureMockMvc
class HomePlanTest {

    static {
        for (String suffix : new String[] { "", "-wal", "-shm" }) {
            new java.io.File("target/test-data/home-plan-test.db" + suffix).delete();
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    ObjectMapper json;

    @Autowired
    AssistantTools tools;

    @Test
    void payInSavingsCountsAndTheLoanKeepsItsName() throws Exception {
        long savings = account("Everyday savings", "SAVINGS");
        LocalDate today = LocalDate.now();

        // Pay twice a month into the savings account, and a $1,000 loan payment on the 23rd.
        for (int back = 4; back >= 1; back--) {
            YearMonth m = YearMonth.from(today).minusMonths(back);
            txn(savings, m.atDay(4), 225164, "C MACK SO");
            txn(savings, m.atDay(19), 225164, "C MACK SO");
            patchCategory(txn(savings, m.atDay(23), -100000, "ACH: USAA FEDERAL SAVINGS BANK").get("id").asLong(), "Loans");
        }
        call(post("/api/paychecks/track"), "{\"pattern\":\"C MACK SO\"}");

        // Claude sees the pay, though it lands in a savings account; never the account's rows.
        JsonNode pay = json.readTree(tools.run("paychecks", json.readTree("{}")));
        assertThat(pay.get("payers")).extracting(p -> p.get("name").asText()).contains("C MACK SO");

        // This month's move to investing leaves the same account, and Home counts it.
        LocalDate moveDay = today.withDayOfMonth(1);
        patchCategory(txn(savings, moveDay, -37500, "TRANSFER TO WEBULL").get("id").asLong(), "Investing");
        JsonNode saving = call(get("/api/summary"), null).get("saving");
        assertThat(saving.get("movedCents").asLong()).isEqualTo(37500);
        assertThat(saving.get("moves")).hasSize(1);

        // Their own name for the loan, on Monthly expenses and wherever the bill shows.
        JsonNode loan = null;
        for (JsonNode i : call(get("/api/recurring"), null).get("items")) {
            if (i.get("name").asText().toUpperCase().contains("USAA")) {
                loan = i;
            }
        }
        assertThat(loan).as("the loan payment is found as a regular charge").isNotNull();
        call(post("/api/recurring/rename"), "{\"key\":\"" + loan.get("key").asText() + "\",\"name\":\"Loan to parents\"}");
        assertThat(call(get("/api/recurring"), null).get("items")).extracting(i -> i.get("name").asText())
                .contains("Loan to parents").noneMatch(n -> n.toUpperCase().contains("USAA"));

        // A blank name goes back to the bank's.
        call(post("/api/recurring/rename"), "{\"key\":\"" + loan.get("key").asText() + "\",\"name\":\"\"}");
        assertThat(call(get("/api/recurring"), null).get("items")).extracting(i -> i.get("name").asText())
                .doesNotContain("Loan to parents");
    }

    @Test
    void homeSaysWhyATargetIsOver() throws Exception {
        long card = account("Card", "CREDIT_CARD");
        LocalDate first = LocalDate.now().withDayOfMonth(1);
        long dining = categoryId("Dining");
        call(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/api/targets/" + dining),
                "{\"monthlyLimitCents\":10000}");
        // One dinner was most of it: that's the reason given, with its note.
        patchNote(patchCategoryAndGet(txn(card, first, -8000, "TST* LA BOUCHERIE").get("id").asLong(), "Dining"), "Birthday dinner");
        patchCategory(txn(card, first, -3000, "SLICE PIZZA").get("id").asLong(), "Dining");
        patchCategory(txn(card, first, -2000, "SLICE PIZZA").get("id").asLong(), "Dining");

        JsonNode why = null;
        for (JsonNode w : call(get("/api/summary"), null).get("spending").get("why")) {
            if (w.get("categoryId").asLong() == dining) {
                why = w;
            }
        }
        assertThat(why).as("Dining is over its target, so Home says why").isNotNull();
        assertThat(why.get("spentCents").asLong()).isEqualTo(13000);
        assertThat(why.get("limitCents").asLong()).isEqualTo(10000);
        assertThat(why.get("driver").asText()).isEqualTo("one");
        assertThat(why.get("label").asText()).isEqualTo("Birthday dinner");
        assertThat(why.get("driverCents").asLong()).isEqualTo(8000);
        assertThat(why.get("count").asInt()).isEqualTo(3);
    }

    // --- helpers ---------------------------------------------------------------------

    private long categoryId(String name) throws Exception {
        for (JsonNode c : call(get("/api/categories"), null)) {
            if (name.equals(c.get("name").asText())) {
                return c.get("id").asLong();
            }
        }
        throw new AssertionError("no category " + name);
    }

    private long patchCategoryAndGet(long txnId, String category) throws Exception {
        patchCategory(txnId, category);
        return txnId;
    }

    private void patchNote(long txnId, String note) throws Exception {
        call(patch("/api/transactions/" + txnId), "{\"notes\":\"" + note + "\"}");
    }

    private long account(String name, String type) throws Exception {
        return call(post("/api/accounts"), String.format("{\"name\":\"%s\",\"type\":\"%s\",\"balanceCents\":0}", name, type))
                .get("id").asLong();
    }

    private JsonNode txn(long accountId, LocalDate day, long cents, String description) throws Exception {
        return call(post("/api/transactions"), String.format(
                "{\"accountId\":%d,\"day\":\"%s\",\"amountCents\":%d,\"description\":\"%s\"}", accountId, day, cents, description));
    }

    private void patchCategory(long txnId, String category) throws Exception {
        long id = -1;
        for (JsonNode c : call(get("/api/categories"), null)) {
            if (category.equals(c.get("name").asText())) {
                id = c.get("id").asLong();
            }
        }
        call(patch("/api/transactions/" + txnId), String.format("{\"categoryId\":%d}", id));
    }

    private JsonNode call(MockHttpServletRequestBuilder request, String body) throws Exception {
        request.with(user("me")).with(csrf());
        if (body != null) {
            request.contentType(MediaType.APPLICATION_JSON).content(body);
        }
        String out = mvc.perform(request).andExpect(status().is2xxSuccessful()).andReturn().getResponse().getContentAsString();
        return out.isEmpty() ? null : json.readTree(out);
    }
}
