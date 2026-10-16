/* ==========================================================================
   LEAGUE DATA — the only file you need to edit week to week.
   Everything on the site renders from this object. Keep valid JS syntax
   (commas between items, quotes around text). Announcement "body" fields
   accept HTML, so <img>, <a>, <b>, GIFs etc. all work here — no MFL limits.

   Teams, divisions, logos, standings, roster and scoring were pulled from
   MFL league 22689 on 2026-10-14.
   ========================================================================== */

window.LEAGUE = {
  name: "Bridgeville 5 Fantasy Site",
  shortName: "B5",                   // shown in the header badge
  established: 2000,
  season: 2026,
  format: "12-Team H2H",
  leagueLogo: "https://www45.myfantasyleague.com/fflnetdynamic2024/22689_league_logo.png",

  // Countdown on the home page. Use ISO time with Eastern offset.
  nextEvent: {
    label: "Trade Deadline",          // TODO: confirm date
    date: "2026-11-20T23:59:00-05:00"
  },

  /* ---- Announcements (newest first) ---------------------------------- */
  announcements: [
    {
      date: "2026-10-14",
      title: "Welcome to the B5 Fantasy Site",
      tag: "Commish",
      body: `<p>This is our home base now. Sign in to see your team on the <a href="#myteam">My Team</a> page. Lineups move here for the 2027 season.
             Everything else (trash talk, history, rules) lives here too.</p>
             <p>And yes, GIFs finally work.</p>`,
      image: "" // optional: direct URL to a .gif/.jpg/.png, shown full-width
    }
  ],

  /* ---- Divisions & teams ---------------------------------------------- */
  divisions: [
    { id: "00", name: "Black" },
    { id: "01", name: "Gold" }
  ],

  // id = MFL franchise ID. manager: MFL doesn't publish owner names — fill in.
  teams: [
    { id: "0001", name: "NSFW",               division: "00", manager: "TBD", titles: 0,
      logo: "https://thechive.com/wp-content/uploads/2020/09/19333eba7693188d57a50a965be13463_width-300.gif?w=300" },
    { id: "0002", name: "Stealers",           division: "01", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2019/22689_franchise_logo0012.png" },
    { id: "0003", name: "H.N.I.C",            division: "01", manager: "TBD", titles: 0,
      logo: "https://media.tenor.com/efJ_7qoDAQkAAAAC/animalhouse-over.gif" },
    { id: "0004", name: "Narcoleptic Dogs",   division: "01", manager: "TBD", titles: 0,
      logo: "https://www43.myfantasyleague.com/fflnetdynamic2004/39900_franchise_logo0004.gif" },
    { id: "0005", name: "The Mighty Mullets", division: "00", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2026/22689_franchise_logo0005.jpg" },
    { id: "0006", name: "Vandelay Industries", division: "00", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2015/22757_franchise_logo0011.gif" },
    { id: "0007", name: "Sissy Boys",         division: "00", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2026/22689_franchise_logo0007.jpg" },
    { id: "0008", name: "The Nutcrackers",    division: "01", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2019/22689_franchise_logo0008.jpg" },
    { id: "0009", name: "Balls on Toast",     division: "00", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2022/22689_franchise_logo0009.jpg" },
    { id: "0010", name: "Puka’s Brain Worm",  division: "01", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnet2026/newhelmets/nh-0211.png" },
    { id: "0011", name: "Mac Daddies",        division: "00", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2021/22689_franchise_logo0011.jpg" },
    { id: "0012", name: "Giddy Up",           division: "01", manager: "TBD", titles: 0,
      logo: "https://www45.myfantasyleague.com/fflnetdynamic2026/22689_franchise_logo0012.jpg" }
  ],

  // @mfl-begin standings (auto-updated by scripts/refresh-mfl.js; edits here get overwritten)
  /* ---- Standings snapshot ---------------------------------------------- */
  // Static copy from MFL, in MFL's tiebreak order.
  standings: {
    asOf: "2026-10-14",
    rows: [ // [franchiseId, W, L, T, PF, PA]
      ["0010",4,1,0,559.9,454.6],
      ["0001",4,1,0,531.8,490.9],
      ["0004",4,1,0,552.4,440.5],
      ["0012",3,2,0,499,469.3],
      ["0009",3,2,0,476.3,484.3],
      ["0005",3,2,0,511.9,467.8],
      ["0007",2,3,0,459.8,473.1],
      ["0002",2,3,0,454.5,448.7],
      ["0008",2,3,0,484.7,488.3],
      ["0011",1,4,0,451.6,504],
      ["0006",1,4,0,405,576.9],
      ["0003",1,4,0,446.2,534.7]
    ]
  },
  // @mfl-end standings

  // @mfl-begin rosters (auto-updated by scripts/refresh-mfl.js; edits here get overwritten)
  /* ---- Rosters snapshot ------------------------------------------------ */
  // Static copy from MFL. MFL's API blocks browser calls from other sites,
  // so run scripts/refresh-mfl.js to update.
  // Each player: [name, position, NFL team, how acquired ("1.07" = round.pick, "Waiv" = waivers), MFL player ID]
  rosters: {
    asOf: "2026-10-14",
    week: 6,
    teams: {
      "0001": [
        ["Joe Burrow","QB","CIN","4.07","14777"],
        ["Michael Penix Jr.","QB","ATL","Waiv (2025)","16583"],
        ["Jonathan Taylor","RB","IND","1.07","14802"],
        ["Ashton Jeanty","RB","LVR","2.06","17042"],
        ["Aaron Jones","RB","MIN","9.11","13319"],
        ["Mike Washington Jr.","RB","LVR","11.02","17482"],
        ["Malik Nabers","WR","NYG","3.06","16615"],
        ["D.J. Moore","WR","BUF","5.07","13635"],
        ["Davante Adams","WR","LAR","6.06","11675"],
        ["Michael Wilson","WR","ARI","7.11","16206"],
        ["Michael Pittman","WR","PIT","10.02","14842"],
        ["Jakobi Meyers","WR","JAC","13.08","14127"],
        ["Makai Lemon","WR","PHI","Waiv","17499"],
        ["George Kittle","TE","SFO","8.02","13299"],
        ["Kenyon Sadiq","TE","NYJ","Waiv","17543"],
        ["Tyler Bass","K","BUF","18.02 (2025)","14983"],
        ["Cincinnati Bengals","DEF","CIN","16.05 (2025)","0506"],
        ["New England Patriots","DEF","NEP","Waiv","0504"]
      ],
      "0002": [
        ["Jalen Hurts","QB","PHI","9.05","14783"],
        ["Matthew Stafford","QB","LAR","11.01","9431"],
        ["Bryce Young","QB","CAR","Waiv","16148"],
        ["Derrick Henry","RB","BAL","1.11","12626"],
        ["Saquon Barkley","RB","PHI","2.02","13604"],
        ["Tony Pollard","RB","TEN","6.02","14085"],
        ["Alvin Kamara","RB","NOS","16.01","13132"],
        ["DeVonta Smith","WR","PHI","3.08","15282"],
        ["Mike Evans","WR","SFO","5.11","11671"],
        ["Matthew Golden","WR","GBP","8.07","17075"],
        ["Khalil Shakir","WR","BUF","13.06","15761"],
        ["Tank Dell","WR","HOU","18.01","16204"],
        ["Tyreek Hill","WR","FA","Waiv","12801"],
        ["Germie Bernard","WR","PIT","Waiv","17503"],
        ["Kyle Pitts","TE","ATL","4.05","15329"],
        ["Juwan Johnson","TE","NOS","10.08","14861"],
        ["Jason Myers","K","SEA","17.12","12437"],
        ["Baltimore Ravens","DEF","BAL","14.07","0531"]
      ],
      "0003": [
        ["Justin Herbert","QB","LAC","7.05","14779"],
        ["Jameis Winston","QB","NYG","Waiv","12140"],
        ["Bijan Robinson","RB","ATL","1.02","16161"],
        ["Jordan Mason","RB","MIN","8.08","15972"],
        ["Blake Corum","RB","LAR","9.03","16593"],
        ["Kaelon Black","RB","SFO","13.05","17485"],
        ["Ollie Gordon II","RB","MIA","Waiv","17059"],
        ["Jonah Coleman","RB","DEN","13.01","17477"],
        ["Kaytron Allen","RB","MIA","","17478"],
        ["George Pickens","WR","DAL","3.05","15762"],
        ["Ladd McConkey","WR","LAC","4.08","16627"],
        ["Tetairoa McMillan","WR","CAR","5.04","17071"],
        ["Tre Tucker","WR","LVR","10.10","16287"],
        ["Jordyn Tyson","WR","NOS","16.12","17498"],
        ["Marvin Harrison Jr.","WR","HOU","7.07","16614"],
        ["Brock Bowers","TE","LVR","2.11","16641"],
        ["Brandon Aubrey","K","DAL","11.10","16414"],
        ["Chicago Bears","DEF","CHI","Waiv","0521"]
      ],
      "0004": [
        ["Drake Maye","QB","NEP","6.07","16580"],
        ["Jared Goff","QB","DET","10.09","12611"],
        ["Malik Willis","QB","MIA","17.02","15694"],
        ["Omarion Hampton","RB","LAC","2.04","17044"],
        ["Breece Hall","RB","NYJ","4.09","15708"],
        ["J.K. Dobbins","RB","DEN","8.11","14800"],
        ["Tyler Allgeier","RB","ARI","13.11","15712"],
        ["Brian Robinson","RB","ATL","16.09","15716"],
        ["Jaxon Smith-Njigba","WR","SEA","1.09","16185"],
        ["Nico Collins","WR","HOU","3.04","15290"],
        ["Jameson Williams","WR","DET","5.06","15756"],
        ["Jordan Addison","WR","MIN","9.04","16186"],
        ["KC Concepcion","WR","CLE","14.02","17501"],
        ["Sam LaPorta","TE","DET","7.02","16214"],
        ["Brenton Strange","TE","JAC","15.04","16269"],
        ["Tyler Loop","K","BAL","18.09 (2025)","17222"],
        ["Denver Broncos","DEF","DEN","12.01","0511"],
        ["Minnesota Vikings","DEF","MIN","Waiv","0524"]
      ],
      "0005": [
        ["Caleb Williams","QB","CHI","7.01","16579"],
        ["Jordan Love","QB","GBP","12.08","14782"],
        ["Kyren Williams","RB","LAR","2.08","15710"],
        ["D'Andre Swift","RB","CHI","4.04","14797"],
        ["David Montgomery","RB","HOU","5.02","14071"],
        ["Chris Rodriguez","RB","JAC","11.12","16174"],
        ["Samaje Perine","RB","CIN","Waiv","13133"],
        ["Amon-Ra St. Brown","WR","DET","1.05","15287"],
        ["Chris Olave","WR","NOS","3.09","15754"],
        ["Chris Godwin","WR","TBB","6.11","13163"],
        ["Wan'Dale Robinson","WR","TEN","9.09","15757"],
        ["Stefon Diggs","WR","WAS","10.04","12186"],
        ["Joshua Palmer","WR","BUF","14.01 (2025)","15319"],
        ["Travis Kelce","TE","KCC","8.12","11244"],
        ["Mike Gesicki","TE","CIN","Waiv","13672"],
        ["Spencer Shrader","K","IND","Waiv","16896"],
        ["Kansas City Chiefs","DEF","KCC","Waiv","0512"],
        ["San Francisco 49ers","DEF","SFO","Waiv","0530"]
      ],
      "0006": [
        ["Patrick Mahomes","QB","KCC","9.07","13116"],
        ["Cam Ward","QB","TEN","17.04","17030"],
        ["Jahmyr Gibbs","RB","DET","1.01","16162"],
        ["Travis Etienne","RB","NOS","3.02","15253"],
        ["Cam Skattebo","RB","NYG","4.11","17045"],
        ["Chuba Hubbard","RB","CAR","5.12","15261"],
        ["Kyle Monangai","RB","CHI","8.09","17066"],
        ["Emeka Egbuka","WR","TBB","2.12","17081"],
        ["Courtland Sutton","WR","DEN","6.01","13630"],
        ["Terry McLaurin","WR","WAS","7.04","14109"],
        ["Romeo Doubs","WR","NEP","10.06","15779"],
        ["Xavier Worthy","WR","KCC","11.07","16620"],
        ["Jalen Coker","WR","CAR","12.06","16809"],
        ["Jerry Jeudy","WR","CLE","13.12","14833"],
        ["Gunnar Helm","TE","TEN","15.07","17105"],
        ["Evan Engram","TE","DEN","9.09 (2025)","13189"],
        ["Jake Bates","K","DET","18.09","16846"],
        ["Buffalo Bills","DEF","BUF","16.06","0501"]
      ],
      "0007": [
        ["Lamar Jackson","QB","BAL","4.12","13593"],
        ["Bo Nix","QB","DEN","10.11","16582"],
        ["Aaron Rodgers","QB","PIT","Waiv","7836"],
        ["Javonte Williams","RB","DAL","2.10","15256"],
        ["Rhamondre Stevenson","RB","NEP","5.10","15259"],
        ["Rico Dowdle","RB","PIT","7.08","14823"],
        ["MarShawn Lloyd","RB","GBP","9.02","16604"],
        ["Braelon Allen","RB","NYJ","11.11 (2025)","16596"],
        ["Ja'Marr Chase","WR","CIN","1.03","15281"],
        ["Christian Watson","WR","GBP","6.03","15789"],
        ["Dontayvion Wicks","WR","PHI","15.11","16195"],
        ["Ja'Kobi Lane","WR","BAL","14.12","17517"],
        ["Alec Pierce","WR","IND","Waiv","15768"],
        ["Demario Douglas","WR","NEP","18.04 (2025)","16342"],
        ["Colston Loveland","TE","CHI","3.01","17104"],
        ["Jake Ferguson","TE","DAL","12.07","15799"],
        ["Cam Little","K","JAC","Waiv","16680"],
        ["Los Angeles Rams","DEF","LAR","11.06","0528"]
      ],
      "0008": [
        ["Trevor Lawrence","QB","JAC","8.10","15237"],
        ["Tyler Shough","QB","NOS","11.08","17039"],
        ["Christian McCaffrey","RB","SFO","1.06","13130"],
        ["Jadarian Price","RB","SEA","4.10","17473"],
        ["Jacory Croskey-Merritt","RB","WAS","9.08","17256"],
        ["Emmett Johnson","RB","KCC","18.07","17474"],
        ["Kendre Miller","RB","NOS","Waiv","16171"],
        ["A.J. Brown","WR","NEP","2.07","14104"],
        ["Drake London","WR","ATL","3.03","15751"],
        ["Garrett Wilson","WR","NYJ","5.03","15753"],
        ["Pat Bryant","WR","DEN","15.08","17082"],
        ["Devaughn Vele","WR","NOS","16.05","16788"],
        ["Adonai Mitchell","WR","NYJ","17.06","16626"],
        ["Keon Coleman","WR","BUF","Waiv","16617"],
        ["Tucker Kraft","TE","GBP","6.10","16222"],
        ["Dalton Schultz","TE","HOU","Waiv","13772"],
        ["Ka'imi Fairbairn","K","HOU","12.05","12860"],
        ["Houston Texans","DEF","HOU","10.05","0532"]
      ],
      "0009": [
        ["Dak Prescott","QB","DAL","5.09","12620"],
        ["Baker Mayfield","QB","TBB","13.07","13590"],
        ["Jacoby Brissett","QB","ARI","14.11 (2019)","12616"],
        ["Chase Brown","RB","CIN","2.01","16181"],
        ["Bhayshul Tuten","RB","JAC","6.04","17052"],
        ["Kenneth Gainwell","RB","TBB","8.04","15255"],
        ["Woody Marks","RB","HOU","11.03","17053"],
        ["CeeDee Lamb","WR","DAL","1.12","14832"],
        ["Tee Higgins","WR","CIN","4.03","14835"],
        ["Carnell Tate","WR","TEN","7.09","17497"],
        ["Keenan Allen","WR","IND","Waiv","11222"],
        ["Kendrick Bourne","WR","ARI","Waiv","13418"],
        ["Trey McBride","TE","ARI","3.10","15794"],
        ["Dallas Goedert","TE","PHI","9.06","13674"],
        ["Pat Freiermuth","TE","PIT","18.04","15331"],
        ["Chase McLaughlin","K","TBB","18.08","14717"],
        ["Seattle Seahawks","DEF","SEA","12.10","0515"],
        ["Los Angeles Chargers","DEF","LAC","15.09","0514"]
      ],
      "0010": [
        ["Brock Purdy","QB","SFO","12.02","15698"],
        ["Sam Darnold","QB","SEA","Waiv","13592"],
        ["Kenneth Walker III","RB","KCC","2.05","15711"],
        ["Bucky Irving","RB","TBB","5.01","16598"],
        ["RJ Harvey","RB","DEN","7.10","17068"],
        ["Rachaad White","RB","WAS","13.03","15721"],
        ["Keaton Mitchell","RB","LAC","14.10","16178"],
        ["Puka Nacua","WR","LAR","1.08","16211"],
        ["Zay Flowers","WR","BAL","3.11","16190"],
        ["Jaylen Waddle","WR","DEN","4.02","15284"],
        ["Luther Burden","WR","CHI","6.12","17070"],
        ["Quentin Johnston","WR","LAC","8.03","16188"],
        ["Denzel Boston","WR","CLE","15.05","17500"],
        ["Jalen McMillan","WR","TBB","16.08","16628"],
        ["Harold Fannin","TE","CLE","10.03","17103"],
        ["Dalton Kincaid","TE","BUF","11.11","16213"],
        ["Will Reichard","K","MIN","18.05","16681"],
        ["Dallas Cowboys","DEF","DAL","10.06 (2024)","0516"]
      ],
      "0011": [
        ["Jayden Daniels","QB","WAS","7.12","16581"],
        ["C.J. Stroud","QB","HOU","15.03","16150"],
        ["Kirk Cousins","QB","LVR","Waiv","10700"],
        ["De'Von Achane","RB","MIA","2.03","16167"],
        ["Jeremiyah Love","RB","ARI","3.07","17472"],
        ["Quinshon Judkins","RB","CLE","5.05","17051"],
        ["Jaylen Warren","RB","PIT","8.01","15742"],
        ["Zach Charbonnet","RB","SEA","14.03","16169"],
        ["Justin Jefferson","WR","MIN","1.10","14836"],
        ["Rashee Rice","WR","KCC","4.06","16194"],
        ["Rome Odunze","WR","CHI","6.08","16616"],
        ["Rashid Shaheed","WR","SEA","11.09","16080"],
        ["Deebo Samuel","WR","SFO","13.10","14136"],
        ["Cooper Kupp","WR","SEA","18.12","13164"],
        ["Isaiah Likely","TE","NYG","9.01","15798"],
        ["Mark Andrews","TE","BAL","12.04","13671"],
        ["Evan McPherson","K","CIN","17.01","15368"],
        ["Jacksonville Jaguars","DEF","JAC","16.10","0509"]
      ],
      "0012": [
        ["Josh Allen","QB","BUF","2.09","13589"],
        ["Deshaun Watson","QB","CLE","Waiv","13113"],
        ["James Cook","RB","BUF","1.04","15715"],
        ["TreVeyon Henderson","RB","NEP","5.08","17043"],
        ["Josh Jacobs","RB","GBP","8.06","14073"],
        ["Chris Brooks","RB","GBP","Waiv","16387"],
        ["Emanuel Wilson","RB","SEA","Waiv","16432"],
        ["Parker Washington","WR","JAC","4.01","16192"],
        ["DK Metcalf","WR","PIT","6.05","14102"],
        ["Josh Downs","WR","IND","9.12","16187"],
        ["Jahan Dotson","WR","ATL","16.07","15755"],
        ["Roman Wilson","WR","PIT","17.07","16629"],
        ["Malachi Fields","WR","NYG","","17511"],
        ["Darius Cooper","WR","PHI","","17333"],
        ["Tyler Warren","TE","IND","3.12","17102"],
        ["T.J. Hockenson","TE","MIN","14.11","14138"],
        ["Chris Boswell","K","PIT","13.02","11936"],
        ["Pittsburgh Steelers","DEF","PIT","12.09","0510"]
      ]
    }
  },
  // @mfl-end rosters

  // @mfl-begin schedule (auto-updated by scripts/refresh-mfl.js; edits here get overwritten)
  /* ---- Schedule snapshot ----------------------------------------------- */
  // Static copy from MFL. Each game: [awayId, awayScore, homeId, homeScore];
  // scores are null until the week is played. Weeks with no games are playoffs (TBD).
  schedule: {
    asOf: "2026-10-14",
    regularSeasonWeeks: 14,
    weeks: [
      { week: 1, games: [
        ["0005",134,"0001",111.7],
        ["0006",76,"0011",129.5],
        ["0007",96,"0009",75],
        ["0002",101,"0012",101.8],
        ["0003",87.5,"0010",128.3],
        ["0004",91.1,"0008",80.8]
      ] },
      { week: 2, games: [
        ["0001",96.4,"0006",88.6],
        ["0011",53.8,"0007",89.5],
        ["0009",120.5,"0005",112.2],
        ["0012",116.1,"0003",57.9],
        ["0010",106.8,"0004",102],
        ["0008",61.7,"0002",72.3]
      ] },
      { week: 3, games: [
        ["0005",74.9,"0006",82.5],
        ["0007",90.2,"0001",92.5],
        ["0011",88.8,"0009",96.7],
        ["0002",102.7,"0003",72.3],
        ["0004",111.6,"0012",97.3],
        ["0010",107.8,"0008",109.5]
      ] },
      { week: 4, games: [
        ["0002",63,"0005",86.5],
        ["0003",138.4,"0006",83.3],
        ["0004",110,"0007",81],
        ["0008",90.9,"0009",114],
        ["0010",120.6,"0011",85.5],
        ["0012",62.6,"0001",104.8]
      ] },
      { week: 5, games: [
        ["0005",104.3,"0003",90.1],
        ["0006",74.6,"0004",137.7],
        ["0007",103.1,"0008",141.8],
        ["0009",70.1,"0010",96.4],
        ["0011",94,"0012",121.2],
        ["0001",126.4,"0002",115.5]
      ] },
      { week: 6, games: [
        ["0006",null,"0007",null],
        ["0009",null,"0001",null],
        ["0005",null,"0011",null],
        ["0003",null,"0004",null],
        ["0008",null,"0012",null],
        ["0002",null,"0010",null]
      ] },
      { week: 7, games: [
        ["0007",null,"0005",null],
        ["0006",null,"0009",null],
        ["0001",null,"0011",null],
        ["0004",null,"0002",null],
        ["0003",null,"0008",null],
        ["0012",null,"0010",null]
      ] },
      { week: 8, games: [
        ["0001",null,"0005",null],
        ["0011",null,"0006",null],
        ["0009",null,"0007",null],
        ["0012",null,"0002",null],
        ["0010",null,"0003",null],
        ["0008",null,"0004",null]
      ] },
      { week: 9, games: [
        ["0004",null,"0005",null],
        ["0008",null,"0006",null],
        ["0010",null,"0007",null],
        ["0012",null,"0009",null],
        ["0002",null,"0011",null],
        ["0003",null,"0001",null]
      ] },
      { week: 10, games: [
        ["0005",null,"0008",null],
        ["0006",null,"0010",null],
        ["0007",null,"0012",null],
        ["0009",null,"0002",null],
        ["0011",null,"0003",null],
        ["0001",null,"0004",null]
      ] },
      { week: 11, games: [
        ["0006",null,"0001",null],
        ["0007",null,"0011",null],
        ["0005",null,"0009",null],
        ["0003",null,"0012",null],
        ["0004",null,"0010",null],
        ["0002",null,"0008",null]
      ] },
      { week: 12, games: [
        ["0006",null,"0005",null],
        ["0001",null,"0007",null],
        ["0009",null,"0011",null],
        ["0003",null,"0002",null],
        ["0012",null,"0004",null],
        ["0008",null,"0010",null]
      ] },
      { week: 13, games: [
        ["0007",null,"0006",null],
        ["0001",null,"0009",null],
        ["0011",null,"0005",null],
        ["0004",null,"0003",null],
        ["0012",null,"0008",null],
        ["0010",null,"0002",null]
      ] },
      { week: 14, games: [
        ["0005",null,"0007",null],
        ["0009",null,"0006",null],
        ["0011",null,"0001",null],
        ["0002",null,"0004",null],
        ["0008",null,"0003",null],
        ["0010",null,"0012",null]
      ] },
      { week: 15, games: [] },
      { week: 16, games: [] },
      { week: 17, games: [] }
    ]
  },
  // @mfl-end schedule

  /* ---- History --------------------------------------------------------- */
  // Newest first. MFL has league archives for every season back to 2000.
  champions: [
    { year: 2025, champion: "TBD", runnerUp: "TBD", lastPlace: "TBD", note: "" },
    { year: 2024, champion: "TBD", runnerUp: "TBD", lastPlace: "TBD", note: "" }
  ],

  /* ---- Traditions ------------------------------------------------------ */
  traditions: [
    { title: "The Trophy",          body: "TODO: describe the trophy and who keeps it." },
    { title: "Last-Place Penalty",  body: "TODO: what the loser has to do." },
    { title: "Draft Day",           body: "TODO: how draft day works and what's expected." }
  ],

  /* ---- Rules ---------------------------------------------------------------
     Display summary only. The scoring engine (src/scoring/rules.ts) is the
     source of truth; keep this in sync with it. */
  scoring: [
    { group: "Touchdowns — paid by length", items: [
      ["Passing TD: 0–30 / 31–50 / 51–75 / 76+ yds", "6 / 8 / 10 / 12"],
      ["Rushing TD: 0–10 / 11–20 / 21–30 / 31–50 / 51+ yds", "6 / 7 / 8 / 10 / 12"],
      ["Receiving TD (QB, RB, WR)", "Passing scale"],
      ["Receiving TD (TE)", "Rushing scale"]
    ]},
    { group: "Receptions", items: [
      ["RB", "0.5"], ["WR", "0.5"], ["TE", "1"]
    ]},
    { group: "Total yards (pass + rush + rec) — tiered", items: [
      ["QB: 50–99 / 100–149 / 150–199", "1 / 2 / 3"], ["QB: 200+", "5, then +2 per 50"],
      ["RB: 25–49 / 50–74 / 75–99", "2 / 4 / 6"], ["RB: 100+", "8, then +2 per 25"],
      ["WR: 25–49 / 50–74 / 75–99", "1 / 2 / 4"], ["WR: 100+", "6, then +2 per 25"],
      ["TE: 1–24 / 25–49 / 50–74", "1 / 2 / 4"], ["TE: 75+", "6, then +2 per 25"]
    ]},
    { group: "Misc offense", items: [
      ["Interception thrown", "-1"], ["2-pt pass / rush / catch", "2"], ["Return or fumble-recovery TD", "6"]
    ]},
    { group: "Kicker", items: [
      ["FG 1–30 yds", "3"], ["FG 31–59 yds", "0.1 × yards"], ["FG 60+", "10"],
      ["Extra point", "1"], ["Any TD scored", "6"]
    ]},
    { group: "Defense", items: [
      ["Defensive / return TD", "6"], ["Interception", "2"], ["Fumble recovery", "2"],
      ["Sack", "1"], ["Safety", "2"], ["Blocked FG / punt", "1"],
      ["Net pass yds allowed 1–149 / 150–174 / 175–199", "6 / 3 / 1"],
      ["Rush yds allowed under 100", "6"], ["No offensive TDs allowed", "8"],
      ["Opponent held scoreless", "2"], ["Defensive 2-pt return", "2"]
    ]}
  ],

  roster: "9 starters: QB, 2 RB, 3 WR, TE, K, DEF (no flex). 18-man roster.",
  // Starting lineup slots, in order. Must match the database (private.slot_position).
  lineupSlots: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"],
  // First season managers set lineups on My Team (Supabase). Before that, My Team shows the roster and a note.
  lineupsFrom: 2027,

  bylaws: [
    "Two divisions, Black and Gold. Head-to-head, weeks 1–14 regular season, playoffs through week 17.",
    "Waivers are first-come, first-served. Standings tiebreakers are set by the commissioner.",
    "Major rule changes are voted on at the end of the season. Simple majority passes.",
    "TODO: trade review policy, playoff seeding, entry fee and payouts."
  ]
};
