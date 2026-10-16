# Pik Dame - rules for an AI player

Pik Dame is a German family Rummy ("Rommé") variant. You play one seat at an
online table against humans and bots. The server enforces every rule; the
`play` tool only offers legal moves, so focus on strategy.

## Material and goal

- 110 cards: two 52-card decks plus 6 jokers. 2-4 players, 15 cards each.
- The match ends once someone reaches 1000 points (house rule "strict": more
  than 1000). Highest total wins.

## Card values

| Cards | Points |
| --- | --- |
| 2-9 | 5 |
| 10, J, Q, K | 10 |
| Ace, Joker | 20 |
| Queen of Spades (Q♠, "Pik Dame") | 100 |

## A turn

1. **Draw**: either the top card of the face-down draw pile, or take the
   discard pile. Taking the discard pile is only allowed when its top card
   forms a NEW meld together with your hand cards. That top card must be laid
   in a new meld immediately (laying it off or a joker swap does not count);
   after that the rest of the discard pile goes onto your hand.
2. **Meld** (optional, any number):
   - lay out a new **set** (3-8 cards of one rank, each suit at most twice)
     or **run** (3-13 cards of one suit in sequence; runs wrap around:
     Q-K-A-2-3 is valid),
   - **lay off** cards onto your OWN melds only (never onto other players'),
   - **swap a joker**: replace a joker in your own meld with the real card it
     stands for; the joker leaves the game (it counts +20 where it lay).
   A second set of a rank you already have on the table is merged into it.
3. **Discard** exactly one card. This ends your turn.

## Going out and scoring

- You go out ONLY by discarding your last card (face down). You can never
  meld your whole hand away - one card must remain for the discard.
- At round end every player scores: points of their laid-out cards MINUS the
  points of the cards still in their hand. The player who went out only adds
  their laid-out points.
- Getting caught with the Queen of Spades in hand costs 100 points. Melding it
  earns 100. Discarding it is allowed, but the next player may be able to take it.
- An empty draw pile is never refilled. If the next player cannot take the
  top discard, the round ends and is scored without a winner. 160 turns
  without any meld also end the round.

## Strategy hints

- Points on the table count, points in hand hurt. Lay out high cards early
  when you can, but keep flexible pairs if they are likely to complete.
- Watch what opponents pick up and discard; avoid discarding cards that
  extend runs or sets the next player is collecting.
- Taking a big discard pile gives you many cards (risk of being caught with
  them) but also many meld options.
- Jokers are valuable: do not throw them away.
