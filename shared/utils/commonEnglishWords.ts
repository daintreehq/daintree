/**
 * Everyday English vocabulary, as base forms. Dictation learning uses it to
 * tell a reworded sentence (modal → model) from a misheard term (zoo stand →
 * Zustand): a correction that lands on an ordinary word is the user choosing
 * different words, not teaching the recogniser a new one.
 */
const WORDS = `
a able about above absolute accept access according account across act action active
activity actual actually add address admin advance advice affect after again against age
agent ago agree ahead aim air alert align all allow almost alone along already also
alter alternative although always amount analyse analysis analyze and animal another
answer any anyone anything anyway anywhere apart appear append apply approach approve
area argue argument arm around arrange array arrive art article ask aspect assign assume
attach attempt attention audio author auto automatic available avoid await aware away
back background bad balance ball bank bar base basic basis batch bear beat beautiful
because become bed before begin behaviour behavior behind believe below benefit best
better between beyond big bill bind bit black blank block blue board body book border
both bottom bound box brain branch brand break bridge brief bright bring broad broken
brother brown browse budget bug build bundle burn business busy but button buy by cache
call calm camera can cancel capital capture car card care career careful carry case cash
cast catch cause cell center central centre certain chain chair challenge chance change
channel chapter char character charge chart chat cheap check chief child choice choose
chunk circle city claim class clean clear click client climb clock close cloud club code
coffee cold collapse collect colour color column combine come comfort command comment
common community company compare complete complex component compose computer concept
concern condition config confirm conflict connect consider console constant contact
contain content context continue contract control convert cookie cool copy core corner
correct cost could count country couple course cover crash create credit cross crowd
current cursor custom customer cut cycle daily damage dark dash data date day dead deal
dear death debug decide decision deep default define degree delay delete deliver demand
deploy depth describe design desk detail detect develop device dialog die diff
difference different difficult digital direct direction directory dirty disable discover
discuss disk display distance divide do doc document dog door double doubt down download
draft drag draw dream dress drink drive drop due during dust duty each early earn earth
easy eat edge edit editor effect effort either element else email embed empty enable
end energy engine enjoy enough ensure enter entire entry environment equal error escape
especially even event ever every evidence exact example except exchange exist expand
expect expensive experience expert explain explore express extend extra eye face fact
factor fail fair fall false family far fast father fault favour favor fear feature feed
feel feeling few field fight figure file fill film filter final finally find fine finger
finish fire firm first fit fix flag flat flow fly focus fold folder follow food foot for
force foreign forget fork form format forward frame free fresh friend from front full
fun function further future gain game gap gate general get give glad glass global go goal
gold good govern grab graph great green ground group grow guard guess guide hair half
hall hand handle hang happen happy hard hash have head health hear heart heat heavy hello
help her here hide high highlight him his history hit hold hole home hook hope host hot
hour house how however huge human idea identify if ignore image imagine impact import
important improve in include increase indeed index indicate inline input insert inside
install instance instead interest internal into issue it item its job join judge jump
just keep key kid kind king kitchen know label lack land language large last late later
launch law lay layer layout lead learn least leave left leg legal length less let letter
level library lie life lift light like limit line link list listen little live load
local lock log logic long look loop lose loss lot love low machine main maintain major
make man manage manual many map mark market master match matter may maybe me mean measure
media meet meeting member memory mention menu merge message method middle might mind
minor minute miss mistake mix mobile mode model modern moment money month more morning
most mother mount mouse move movie much music must my name narrow nation native natural
near nearly need network never new news next nice night no none normal not note nothing
notice now null number object obvious occur of off offer office often oh old on once one
only open operate option or order ordinary origin other our out output outside over own
owner pack package page pain paint pair pane panel paper parent parse part particular
partner party pass password past paste patch path pattern pause pay peace people per
perfect perform perhaps period permission person phase phone pick picture piece pin pipe
place plain plan plant platform play please plus point policy poll pool poor pop popular
port position possible post potential power practice prefer prepare present press pretty
prevent preview previous price print priority private probably problem process produce
product profile program progress project prompt proof proper property protect prove
provide public publish pull purpose push put quality quarter query question queue quick
quickly quiet quite quote race radio rain raise range rate rather raw reach react read
ready real reality really reason receive recent record red reduce refer region register
regular reject relate release remain remember remote remove render repeat replace reply
report request require reset resize resolve resource response rest restart restore result
retry return reveal review right ring rise risk road rock role roll room root round route
row rule run safe sale same sample save say scale scan scene school score screen script
scroll search season seat second secret section secure see seem select self sell send
sense separate series serious serve server service session set setting settle setup
several shape share sharp she sheet shell shift ship shop short shot should show side
sign signal silent similar simple since single site size skip sleep slide slow small smart
snap so social soft software solid solution solve some someone something sometimes song
soon sorry sort sound source space speak special speed spend split spot spread square
stack staff stage stand standard star start state station status stay step stick still
stop storage store story straight strange stream street strong structure student study
style subject submit success such suggest suit summary support suppose sure surface
switch symbol sync system table tag take talk target task team tell template term
terminal text than thank that the their them then theory there these they thing think
this those though thought thread through throw thus ticket tie till time tiny tip title
to today together token too tool top topic total touch toward track trade train transfer
travel treat trigger trim trouble true trust try turn type under understand unit until up
update upgrade upload upon us use user usual value variable various version very video
view visible visit voice wait walk wall want war warn watch water way we weak wear web week
weight welcome well what whatever wheel when where whether which while white who whole why
wide wife will win window wish with within without woman wonder word work world worry
worth would wrap write wrong yeah year yes yet you young your zone
am an are as at awhile be been did does etc had has he i is me nor okay ok shall so us
was were whom whose
able ability above accident across actor adult afford afraid agency agenda alarm alive
angle angry annual anxious apartment appeal apple april arrival artist assist
attack attend attitude august average award bag band base basket bath battle beach
beauty bedroom beer bell belt bench bet bike bird birth bite bitter blame blind blood
blow boat bone bonus boot boss bother bowl brave bread breath brick bunch burden bus
cabinet cake campaign cancer candidate cap capacity carbon cat cattle ceiling chain
cheese chest chicken chip church citizen civil classic climate coach coast coat
collection college combination comedy commercial commission commit competition
complain concert conference congress connection consequence construction consumer
contest cook corporate cotton council courage court cousin crack craft crazy cream
crew crime crisis criteria critical crop cup currency curve cute dance danger dad
debate decade deck decline deficit delight democracy dentist departure deputy desert
desire destroy diet dinner dirt disaster discount disease dish distinct district
divorce doctor dollar domestic draw drama drawer driver drug dry duck dumb ear east
economy edition educate effective efficient egg elect electric elephant emergency
emotion employ engineer enormous entertain equipment essay estate estimate evening
evil exam excellent excite excuse exercise exhibit expense fan fancy farm fashion fat
fee female fence festival fever fiction finance fish flight flood floor flower fold
football forest fortune founder fruit fuel funny furniture garage garden gas gene
gentle gift girl glove golf grade grain grand grass gray grey guest guitar gun guy
habit happen harm hat hate hell hero highway hill hire holiday honest honey horror
horse hospital hotel hunt husband ice illness income injury insect inspector
insurance intend invest iron island jacket joke journey juice jury kick kill kind kiss
knife lab ladder lady lake lamp lawyer leader league lean lecture lemon lesson liberal
lip liquid literature loan lonely lucky lunch luxury mad magazine mail male mall manner
marriage mass meal meat medicine mess metal milk minister mirror mission mom monitor
mood moon motor mountain mouth mud murder muscle museum mystery nail neck nerve nest
nose novel nurse nut ocean odd oil onion orange organic oven pace palm pan pants pen
pencil pension pepper pet piano pie pig pilot pink pipe pitch pizza planet plastic
plate pleasure pocket poem poet poetry police politics pond porch potato pound
pressure prince prison prize profit promise proposal prospect proud pub pupil purple
puzzle rabbit rail rare rat recipe regret relief religion rent rescue rice rich ride
river rope rose rough royal rub rubber rush sad salad salary salt sand sauce scared
scope screw sea senate senior sentence settle shadow shame shape shirt shoe shoulder
sick silly silver singer sister skill skin sky slave slice slip smell smile smoke snow
soap soccer sock soil soldier soul soup south spare spirit sport spouse spring stable
stadium steal steel stomach stone storm strategy straw stress stretch strike strip
stuff stupid sugar suicide summer sun sweet swim sword tail tale tank tape taste tax
tea teacher tear teen temple tennis tent terror theatre theater thick thin thumb
tight tire tired toe tomato tone tongue tooth tour tourist towel tower town toy
tradition traffic tragedy trail trash tree trial trick trip truck tune twin uncle
union unique university valley vehicle victim village virus vote wage waste weapon
weather wedding west wet wild wine wing winter wire wise witness wolf wood wool worker
yard yellow youth
`;

let vocabulary: Set<string> | null = null;

function getVocabulary(): Set<string> {
  vocabulary ??= new Set(WORDS.split(/\s+/).filter(Boolean));
  return vocabulary;
}

/** Base forms one suffix away from `word`: sessions → session, studies → study. */
function strippedForms(word: string): string[] {
  const forms: string[] = [];
  const strip = (suffix: string) =>
    word.length > suffix.length + 2 && word.endsWith(suffix) ? word.slice(0, -suffix.length) : null;

  if (word.length > 4 && word.endsWith("ies")) forms.push(word.slice(0, -3) + "y");
  const es = strip("es");
  if (es) forms.push(es);
  const s = strip("s");
  if (s && !word.endsWith("ss")) forms.push(s);
  if (word.endsWith("ly")) {
    const ly = strip("ly");
    if (ly) forms.push(ly);
  }
  for (const suffix of ["ed", "ing", "er", "est"]) {
    const stem = strip(suffix);
    if (!stem) continue;
    forms.push(stem, stem + "e");
    // stopped → stop, bigger → big
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      forms.push(stem.slice(0, -1));
    }
    if (stem.endsWith("i")) forms.push(stem.slice(0, -1) + "y");
  }
  return forms;
}

/** `word` and what it could be inflected from, two suffixes deep (players → play). */
function baseForms(word: string): string[] {
  const once = strippedForms(word);
  return [word, ...once, ...once.flatMap(strippedForms)];
}

/**
 * Whether a lowercase alphanumeric word is ordinary English, inflections
 * included. `extra` holds more words to count as ordinary, in base form.
 */
export function isCommonEnglishWord(normalized: string, extra?: ReadonlySet<string>): boolean {
  const words = getVocabulary();
  return baseForms(normalized).some((form) => words.has(form) || !!extra?.has(form));
}
